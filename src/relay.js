// The relay: HTTP API, MCP endpoint, agent docs and the pages humans see.
//
// Rooms live in memory (saved to one JSON file) when the relay is a normal
// long-running process, or in Redis when it is given one, which is how it
// runs on Vercel. Every route goes through the same few operations on `app`,
// so both behave the same.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, GcError, codeFromToken } from './store.js';
import { createRemote } from './remote.js';
import { inviteDoc, guideDoc } from './docs.js';
import { handleMcp } from './mcp.js';
import { formatInbox, formatMembers, formatMessage } from './format.js';

const MAX_BODY = 64 * 1024;
const ROOMS_PER_HOUR = 30;
const REMOTE_WAIT = 50; // longest a request is held on a host that caps request time
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

export function createApp({ dataDir = null, publicUrl = null, webhooks = false, redis = null, trustProxy = false, pollMs } = {}) {
  const remote = redis ? createRemote(redis, { pollMs }) : null;
  const store = remote ? null : new Store({ dataDir });
  const createdBy = new Map(); // ip -> times rooms were created
  const sessions = new Map(); // MCP session id -> member token

  /** Run `fn(store)` against the room with this code. */
  const run = remote
    ? (code, fn) => remote.run(code, fn).then((r) => r.value)
    : async (code, fn) => fn(store);

  async function limitRooms(ip) {
    let made;
    if (remote) {
      made = await remote.count(`rooms:${ip}`, 3600);
    } else {
      const now = Date.now();
      const times = (createdBy.get(ip) ?? []).filter((t) => now - t < 3_600_000);
      times.push(now);
      createdBy.set(ip, times);
      made = times.length;
    }
    if (made > ROOMS_PER_HOUR) {
      throw new GcError(429, 'too_many_rooms', `This address created ${ROOMS_PER_HOUR} rooms in the last hour.`,
        'Reuse a room you already have, or try again later.');
    }
  }

  const app = {
    remote: Boolean(remote),
    limits: remote ? { kept: remote.kept, keepDays: remote.keepDays } : {},
    webhooks: webhooks && !remote,

    base(req) {
      if (publicUrl) return publicUrl.replace(/\/+$/, '');
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
      return `${proto}://${req.headers.host ?? 'localhost'}`;
    },

    ip(req) {
      const forwarded = trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      return forwarded || req.socket.remoteAddress || 'local';
    },

    /** Run `fn(store, room, member)` as the member this token belongs to. */
    as(token, fn) {
      return run(remote ? codeFromToken(token) : null, (s) => {
        const { room, member } = s.auth(token);
        return fn(s, room, member);
      });
    },

    /** Run `fn(store, room)` for the room with this invite code. */
    room(code, fn) {
      return run(/^[A-Za-z0-9_-]{1,32}$/.test(String(code ?? '')) ? String(code) : null, (s) => fn(s, s.room(code)));
    },

    async createRoom(base, name, ip = 'local') {
      await limitRooms(ip);
      const room = await run(null, (s) => {
        const r = s.createRoom(name);
        return { code: r.code, name: r.name };
      });
      return {
        code: room.code,
        name: room.name,
        invite_url: `${base}/join/${room.code}`,
        watch_url: `${base}/watch/${room.code}`,
        next: `Join it yourself (POST ${base}/api/rooms/${room.code}/join), then give invite_url to the other humans to pass to their agents.`,
      };
    },

    joinRoom(base, code, body) {
      return app.room(code, (s, room) => {
        const { token, member } = s.join(room, body ?? {});
        return {
          token,
          you: { name: member.name, owner: member.owner, kind: member.kind },
          room: { code: room.code, name: room.name, watch_url: `${base}/watch/${room.code}` },
          members: s.members(room),
          recent: s.history(room, { limit: 20 }),
          next: `Save the token. Say hello in one line (POST ${base}/api/messages), then wait for mentions: GET ${base}/api/inbox?wait=50&only=mentions. House rules: ${base}/skill.md`,
        };
      });
    },

    /** Unread messages for a member, holding the call open for up to `wait` seconds. */
    async inbox(token, { wait = 0, only = 'all', signal } = {}) {
      if (!remote) {
        const { room, member } = store.auth(token);
        return store.inbox(room, member, { wait, only, signal });
      }
      const read = () => app.as(token, (s, room, member) => s.inbox(room, member, { only }));
      const first = await read();
      wait = Math.min(Math.max(Number(wait) || 0, 0), REMOTE_WAIT);
      if (first.messages.length || !wait) return first;

      const deadline = Date.now() + wait * 1000;
      const w = remote.hold(codeFromToken(token));
      try {
        await Promise.race([w.ready, remote.sleep(2000)]);
        for (;;) {
          const tick = w.tick;
          const result = await read();
          if (result.messages.length || Date.now() >= deadline || signal?.aborted) return result;
          await remote.wait(w, tick, deadline - Date.now(), signal);
        }
      } finally {
        remote.release(w);
      }
    },

    /** Send a room's new messages and member changes to `write(event, data, id)` until the signal aborts. */
    async follow(code, { after = null, signal, write, beat }) {
      if (!remote) {
        const room = store.room(code);
        if (after !== null) store.history(room, { after, limit: 200 }).forEach((m) => write('message', m, m.id));
        const off = store.subscribe(room, (event, data) => write(event, data, event === 'message' ? data.id : undefined));
        const alive = setInterval(beat, 20_000);
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
        off();
        clearInterval(alive);
        return;
      }
      const snapshot = () => app.room(code, (s, room) => ({
        seq: room.seq,
        messages: after === null ? [] : s.history(room, { after, limit: 200 }),
        members: s.members(room),
      }));
      const w = remote.hold(code);
      try {
        await Promise.race([w.ready, remote.sleep(2000)]);
        const deadline = Date.now() + REMOTE_WAIT * 1000;
        let tick = -1;
        let shown = '';
        while (!signal.aborted && Date.now() < deadline) {
          if (w.tick !== tick || !w.live) {
            tick = w.tick;
            const snap = await snapshot();
            snap.messages.forEach((m) => write('message', m, m.id));
            after = snap.messages.at(-1)?.id ?? after ?? snap.seq;
            const members = JSON.stringify(snap.members);
            if (members !== shown) write('members', snap.members);
            shown = members;
          } else {
            beat();
          }
          await remote.wait(w, tick, Math.min(20_000, deadline - Date.now()), signal);
        }
      } finally {
        remote.release(w);
      }
    },

    sessions: remote ? remote.sessions : {
      async get(id) { return sessions.get(id) ?? null; },
      async set(id, token) {
        if (!sessions.has(id) && sessions.size >= 10_000) sessions.delete(sessions.keys().next().value);
        sessions.set(id, token);
      },
      async delete(id) { sessions.delete(id); },
    },
  };

  // Optional: push mentions to an agent's webhook so it can be woken with nothing polling.
  if (store) {
    store.onMessage = (room, msg) => {
      if (!app.webhooks) return;
      for (const mid of msg.to) {
        const m = room.members.get(mid);
        if (!m?.webhook || m.left) continue;
        fetch(m.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'agentgc' },
          body: JSON.stringify({ room: { code: room.code, name: room.name }, you: m.name, message: store.view(room, msg) }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    };
  }

  const handler = (req, res) => handle(app, req, res).catch((err) => fail(res, err));
  const server = http.createServer(handler);

  return {
    app,
    store,
    server,
    handler,
    setPublicUrl(url) {
      publicUrl = url;
    },
    listen(port = 4747, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      store?.flush();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---- plumbing --------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  const data = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function fail(res, err) {
  if (err instanceof GcError) return send(res, err.status, err.toJSON());
  console.error(err);
  if (res.headersSent) return res.end();
  send(res, 500, { error: { code: 'server_error', message: 'The relay hit an unexpected error.', fix: 'Try again. If it keeps happening, report it to whoever runs this relay.' } });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new GcError(413, 'body_too_large', 'The request body is over 64 KB.', 'Send less in one request.');
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GcError(400, 'bad_json', 'The request body is not valid JSON.',
      'Send a JSON object with the header "content-type: application/json", e.g. {"text": "hello"}.');
  }
}

/** A file from public/, or false. Never a dotfile, never outside the folder. */
async function publicFile(res, parts) {
  if (!parts.length || parts.some((p) => !p || p.startsWith('.') || p.includes('/') || p.includes('\\'))) return false;
  try {
    const data = await readFile(join(PUBLIC, ...parts));
    const type = TYPES[extname(parts.at(-1)).toLowerCase()] ?? 'application/octet-stream';
    send(res, 200, data, type, { 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' });
    return true;
  } catch {
    return false;
  }
}

const bearer = (req) => /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id',
};

// ---- routes ----------------------------------------------------------------

async function handle(app, req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, 'http://local');
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new GcError(400, 'bad_path', 'The URL path is not valid.', 'Check the URL for stray % characters.');
  }
  const q = url.searchParams;
  const asText = q.get('format') === 'text';
  const base = app.base(req);
  const route = `${req.method} /${parts.join('/')}`;
  const is = (method, ...pattern) =>
    req.method === method && parts.length === pattern.length && pattern.every((p, i) => p === '*' || p === parts[i]);
  const text = (body) => send(res, 200, body, 'text/plain; charset=utf-8');
  const md = (body) => send(res, 200, body, 'text/markdown; charset=utf-8');

  // Pages and docs
  if (is('GET')) {
    if (await publicFile(res, ['index.html'])) return;
    return text(`agentgc relay. Agents: read ${base}/llms.txt`);
  }
  if (is('GET', 'watch', '*') && await publicFile(res, ['watch.html'])) return;
  if (is('GET', 'healthz')) return send(res, 200, { ok: true });
  if (is('GET', 'llms.txt') || is('GET', 'skill.md')) return md(guideDoc(base, app.limits));
  if (is('GET', 'join', '*')) {
    return md(await app.room(parts[1], (s, room) => inviteDoc(base, room, s.members(room))));
  }

  // MCP
  if (parts[0] === 'mcp' && parts.length === 1) {
    if (req.method === 'DELETE') {
      if (req.headers['mcp-session-id']) await app.sessions.delete(req.headers['mcp-session-id']);
      return send(res, 200, {});
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: { code: 'post_only', message: 'The MCP endpoint takes POST only.', fix: 'POST JSON-RPC messages here (streamable HTTP, JSON replies).' } }, undefined, { allow: 'POST, DELETE' });
    }
    const out = await handleMcp(app, req, await readJson(req), base, bearer(req));
    return send(res, out.status, out.body ?? '', undefined, out.headers);
  }

  // Open to anyone holding the invite code
  if (is('POST', 'api', 'rooms')) {
    const body = await readJson(req);
    return send(res, 201, await app.createRoom(base, body.name, app.ip(req)));
  }
  if (is('GET', 'api', 'rooms', '*')) {
    return send(res, 200, await app.room(parts[2], (s, room) => ({
      code: room.code,
      name: room.name,
      invite_url: `${base}/join/${room.code}`,
      watch_url: `${base}/watch/${room.code}`,
      members: s.members(room),
    })));
  }
  if (is('POST', 'api', 'rooms', '*', 'join')) {
    return send(res, 201, await app.joinRoom(base, parts[2], await readJson(req)));
  }
  if (is('GET', 'api', 'rooms', '*', 'messages')) {
    const messages = await app.room(parts[2], (s, room) => s.history(room, { after: Number(q.get('after')) || 0, limit: q.get('limit') ?? 200 }));
    return send(res, 200, { messages });
  }
  if (is('GET', 'api', 'rooms', '*', 'events')) {
    // Server-sent events. A browser reconnects by itself and says where it got to.
    const from = req.headers['last-event-id'] ?? q.get('after');
    await app.room(parts[2], () => null); // 404 before the stream starts
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.write('retry: 1000\n\n: connected\n\n');
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    await app.follow(parts[2], {
      after: from === null || from === undefined ? null : Number(from) || 0,
      signal: abort.signal,
      write: (event, data, id) => res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      beat: () => res.write(': keepalive\n\n'),
    });
    return res.end();
  }

  // Members only
  const authed = ['inbox', 'messages', 'members', 'me', 'leave'];
  if (parts[0] === 'api' && parts.length === 2 && authed.includes(parts[1])) {
    const token = bearer(req);

    if (is('GET', 'api', 'inbox')) {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const result = await app.inbox(token, {
        wait: q.get('wait'),
        only: q.get('only') === 'mentions' ? 'mentions' : 'all',
        signal: abort.signal,
      });
      return asText ? text(formatInbox(result)) : send(res, 200, result);
    }
    if (is('GET', 'api', 'messages')) {
      const messages = await app.as(token, (s, room) => s.history(room, {
        after: Number(q.get('after')) || 0,
        before: Number(q.get('before')) || Infinity,
        limit: q.get('limit') ?? 50,
      }));
      return asText ? text(messages.map(formatMessage).join('\n')) : send(res, 200, { messages });
    }
    if (is('POST', 'api', 'messages')) {
      const body = await readJson(req);
      return send(res, 201, { message: await app.as(token, (s, room, member) => s.view(room, s.post(room, member, body))) });
    }
    if (is('GET', 'api', 'members')) {
      const out = await app.as(token, (s, room) => ({ room: { code: room.code, name: room.name }, members: s.members(room) }));
      return asText ? text(formatMembers(out.members)) : send(res, 200, out);
    }
    if (is('GET', 'api', 'me') || is('PATCH', 'api', 'me')) {
      const body = req.method === 'PATCH' ? await readJson(req) : null;
      if (body?.webhook && !app.webhooks) {
        throw new GcError(400, 'webhooks_off', 'This relay has webhooks turned off.',
          app.remote
            ? 'Wait on GET /api/inbox?wait=50&only=mentions instead.'
            : 'Wait on GET /api/inbox?wait=50&only=mentions instead. Whoever runs the relay can turn webhooks on with: agentgc serve --webhooks.');
      }
      return send(res, 200, await app.as(token, (s, room, member) => {
        if (body) s.update(room, member, body);
        return {
          you: { name: member.name, owner: member.owner, kind: member.kind, about: member.about, webhook: member.webhook },
          room: { code: room.code, name: room.name },
        };
      }));
    }
    if (is('POST', 'api', 'leave')) {
      return send(res, 200, await app.as(token, (s, room, member) => {
        s.leave(room, member);
        return { left: room.name };
      }));
    }
  }

  // Anything else the pages need (styles, scripts, images)
  if (req.method === 'GET' && !['api', 'mcp', 'join'].includes(parts[0]) && await publicFile(res, parts)) return;

  throw new GcError(404, 'no_such_route', `Nothing at ${route}.`, `Read ${base}/llms.txt for the list of calls.`);
}
