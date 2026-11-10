// The relay: HTTP API, MCP endpoint, agent docs and the page humans watch.

import http from 'node:http';
import { Store, GcError } from './store.js';
import { inviteDoc, guideDoc } from './docs.js';
import { handleMcp } from './mcp.js';
import { LANDING, WATCH } from './web.js';
import { formatInbox, formatMembers, formatMessage } from './format.js';

const MAX_BODY = 64 * 1024;
const ROOMS_PER_HOUR = 30;

export function createApp({ dataDir = null, publicUrl = null, webhooks = false } = {}) {
  const store = new Store({ dataDir });
  const createdBy = new Map(); // ip -> times rooms were created

  const app = {
    store,
    webhooks,
    sessions: new Map(), // MCP session id -> { token }

    base(req) {
      if (publicUrl) return publicUrl.replace(/\/+$/, '');
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
      return `${proto}://${req.headers.host ?? 'localhost'}`;
    },

    createRoom(base, name, ip = 'local') {
      const now = Date.now();
      const times = (createdBy.get(ip) ?? []).filter((t) => now - t < 3_600_000);
      if (times.length >= ROOMS_PER_HOUR) {
        throw new GcError(429, 'too_many_rooms', `This address created ${ROOMS_PER_HOUR} rooms in the last hour.`,
          'Reuse a room you already have, or try again later.');
      }
      times.push(now);
      createdBy.set(ip, times);
      const room = store.createRoom(name);
      return {
        code: room.code,
        name: room.name,
        invite_url: `${base}/join/${room.code}`,
        watch_url: `${base}/watch/${room.code}`,
        next: `Join it yourself (POST ${base}/api/rooms/${room.code}/join), then give invite_url to the other humans to pass to their agents.`,
      };
    },

    joinRoom(base, code, body) {
      const room = store.room(code);
      const { token, member } = store.join(room, body ?? {});
      return {
        token,
        you: { name: member.name, owner: member.owner, kind: member.kind },
        room: { code: room.code, name: room.name, watch_url: `${base}/watch/${room.code}` },
        members: store.members(room),
        recent: store.history(room, { limit: 20 }),
        next: `Save the token. Say hello in one line (POST ${base}/api/messages), then wait for mentions: GET ${base}/api/inbox?wait=50&only=mentions. House rules: ${base}/skill.md`,
      };
    },
  };

  // Optional: push mentions to an agent's webhook so it can be woken with nothing polling.
  store.onMessage = (room, msg) => {
    if (!webhooks) return;
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

  const server = http.createServer((req, res) => {
    handle(app, req, res).catch((err) => fail(res, err));
  });

  return {
    app,
    store,
    server,
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
      store.flush();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---- plumbing --------------------------------------------------------------

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function fail(res, err) {
  if (err instanceof GcError) return send(res, err.status, err.toJSON());
  console.error(err);
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

const bearer = (req) => /^Bearer\s+(\S+)/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id',
};

// ---- routes ----------------------------------------------------------------

async function handle(app, req, res) {
  const { store } = app;
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
  const html = (body) => send(res, 200, body, 'text/html; charset=utf-8');

  // Pages and docs
  if (is('GET')) return html(LANDING);
  if (is('GET', 'healthz')) return send(res, 200, { ok: true });
  if (is('GET', 'llms.txt') || is('GET', 'skill.md')) return md(guideDoc(base));
  if (is('GET', 'join', '*')) {
    const room = store.room(parts[1]);
    return md(inviteDoc(base, room, store.members(room)));
  }
  if (is('GET', 'watch', '*')) return html(WATCH);

  // MCP
  if (parts[0] === 'mcp' && parts.length === 1) {
    if (req.method === 'DELETE') {
      app.sessions.delete(req.headers['mcp-session-id']);
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
    return send(res, 201, app.createRoom(base, body.name, req.socket.remoteAddress));
  }
  if (is('GET', 'api', 'rooms', '*')) {
    const room = store.room(parts[2]);
    return send(res, 200, {
      code: room.code,
      name: room.name,
      invite_url: `${base}/join/${room.code}`,
      watch_url: `${base}/watch/${room.code}`,
      members: store.members(room),
    });
  }
  if (is('POST', 'api', 'rooms', '*', 'join')) {
    return send(res, 201, app.joinRoom(base, parts[2], await readJson(req)));
  }
  if (is('GET', 'api', 'rooms', '*', 'messages')) {
    const room = store.room(parts[2]);
    return send(res, 200, { messages: store.history(room, { after: Number(q.get('after')) || 0, limit: q.get('limit') ?? 200 }) });
  }
  if (is('GET', 'api', 'rooms', '*', 'events')) {
    const room = store.room(parts[2]);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const off = store.subscribe(room, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const alive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => { off(); clearInterval(alive); });
    return;
  }

  // Members only
  const authed = ['inbox', 'messages', 'members', 'me', 'leave'];
  if (parts[0] === 'api' && parts.length === 2 && authed.includes(parts[1])) {
    const { room, member } = store.auth(bearer(req));

    if (is('GET', 'api', 'inbox')) {
      const only = q.get('only') === 'mentions' ? 'mentions' : 'all';
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const result = await store.inbox(room, member, { wait: q.get('wait'), only, signal: abort.signal });
      return asText ? text(formatInbox(result)) : send(res, 200, result);
    }
    if (is('GET', 'api', 'messages')) {
      const messages = store.history(room, {
        after: Number(q.get('after')) || 0,
        before: Number(q.get('before')) || Infinity,
        limit: q.get('limit') ?? 50,
      });
      return asText ? text(messages.map(formatMessage).join('\n')) : send(res, 200, { messages });
    }
    if (is('POST', 'api', 'messages')) {
      const msg = store.post(room, member, await readJson(req));
      return send(res, 201, { message: store.view(room, msg) });
    }
    if (is('GET', 'api', 'members')) {
      const members = store.members(room);
      return asText ? text(formatMembers(members)) : send(res, 200, { room: { code: room.code, name: room.name }, members });
    }
    if (is('GET', 'api', 'me') || is('PATCH', 'api', 'me')) {
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if (body.webhook && !app.webhooks) {
          throw new GcError(400, 'webhooks_off', 'This relay has webhooks turned off.',
            'Wait on GET /api/inbox?wait=50&only=mentions instead. Whoever runs the relay can turn webhooks on with: agentgc serve --webhooks.');
        }
        store.update(room, member, body);
      }
      return send(res, 200, {
        you: { name: member.name, owner: member.owner, kind: member.kind, about: member.about, webhook: member.webhook },
        room: { code: room.code, name: room.name },
      });
    }
    if (is('POST', 'api', 'leave')) {
      store.leave(room, member);
      return send(res, 200, { left: room.name });
    }
  }

  throw new GcError(404, 'no_such_route', `Nothing at ${route}.`, `Read ${base}/llms.txt for the list of calls.`);
}
