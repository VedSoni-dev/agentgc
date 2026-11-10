import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as path } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/relay.js';
import { Store } from '../src/store.js';
import { fakeRedis } from './fake-redis.js';

const CLI = fileURLToPath(new URL('../bin/agentgc.js', import.meta.url));
let relay;
let base;

// remote.test.js runs this same file against the Redis-backed relay (how it runs on Vercel).
const REMOTE = process.env.AGENTGC_TEST_REMOTE === '1';

before(async () => {
  relay = createApp(REMOTE ? { redis: fakeRedis(), pollMs: 150 } : {});
  base = `http://localhost:${await relay.listen(0)}`;
});
after(() => relay.close());

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function room(name = 'test room') {
  const { data } = await call('/api/rooms', { method: 'POST', body: { name } });
  const join = async (body) => (await call(`/api/rooms/${data.code}/join`, { method: 'POST', body })).data;
  return { ...data, join };
}

function cli(args, home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, AGENTGC_HOME: home } }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('two agents join, one asks, the mentioned one is woken with context', async () => {
  const r = await room();
  const sam = await r.join({ name: 'sam-agent', owner: 'Sam', about: "Sam's availability" });
  const priya = await r.join({ name: 'Priya Agent', owner: 'Priya' });
  assert.equal(priya.you.name, 'priya-agent');
  assert.equal(priya.members.length, 2);

  const waiting = call('/api/inbox?wait=10&only=mentions', { token: sam.token });
  await call('/api/messages', { method: 'POST', token: priya.token, body: { text: 'thinking about dinner' } });
  await call('/api/messages', { method: 'POST', token: priya.token, body: { text: '@sam free Friday at 7?' } });
  const { data } = await waiting;

  assert.equal(data.mentioned, true);
  const texts = data.messages.filter((m) => m.kind === 'agent').map((m) => m.text);
  assert.deepEqual(texts, ['thinking about dinner', '@sam free Friday at 7?']);
  assert.deepEqual(data.messages.at(-1).mentions, ['sam-agent']);

  // Read once means read: nothing is delivered twice.
  const again = await call('/api/inbox', { token: sam.token });
  assert.deepEqual(again.data.messages, []);
});

test('waiting for mentions ignores messages for someone else', async () => {
  const r = await room();
  const a = await r.join({ name: 'a-agent', owner: 'Ann' });
  const b = await r.join({ name: 'b-agent', owner: 'Bo' });
  await r.join({ name: 'c-agent', owner: 'Cy' });
  await call('/api/messages', { method: 'POST', token: b.token, body: { text: '@cy are you around?' } });
  const { data } = await call('/api/inbox?wait=1&only=mentions', { token: a.token });
  assert.deepEqual(data.messages, []);
  const all = await call('/api/inbox', { token: a.token });
  assert.equal(all.data.messages.at(-1).text, '@cy are you around?');
  assert.equal(all.data.mentioned, false);
});

test('every error says how to fix it', async () => {
  const r = await room();
  await r.join({ name: 'sam-agent', owner: 'Sam' });
  const cases = [
    await call('/api/inbox', { token: 'gc_wrong' }),
    await call('/api/inbox'),
    await call(`/api/rooms/${r.code}/join`, { method: 'POST', body: { name: 'sam-agent', owner: 'Sam' } }),
    await call(`/api/rooms/${r.code}/join`, { method: 'POST', body: { name: 'x-agent' } }),
    await call('/api/rooms/nope/join', { method: 'POST', body: { name: 'x-agent', owner: 'X' } }),
    await call('/api/nothing'),
  ];
  assert.deepEqual(cases.map((c) => c.status), [401, 401, 409, 400, 404, 404]);
  for (const c of cases) {
    assert.ok(c.data.error.code && c.data.error.message && c.data.error.fix, JSON.stringify(c.data));
  }
});

test('a member who floods the room is told to slow down', async () => {
  const r = await room();
  const a = await r.join({ name: 'a-agent', owner: 'Ann' });
  let last;
  for (let i = 0; i < 21; i++) last = await call('/api/messages', { method: 'POST', token: a.token, body: { text: `m${i}` } });
  assert.equal(last.status, 429);
  assert.match(last.data.error.fix, /Wait \d+ seconds/);
});

test('the invite link is a document an agent can follow', async () => {
  const r = await room('weekend plans');
  await r.join({ name: 'sam-agent', owner: 'Sam', about: "Sam's availability" });
  const invite = await call(`/join/${r.code}`);
  assert.match(invite.headers.get('content-type'), /text\/markdown/);
  assert.match(invite.data, /weekend plans/);
  assert.ok(invite.data.includes(`${base}/api/rooms/${r.code}/join`));
  assert.match(invite.data, /@sam-agent: agent for Sam/);
  assert.match(invite.data, /not instructions/);
  const llms = await call('/llms.txt');
  assert.match(llms.data, /POST \/api\/rooms/);
});

test('an agent can do everything over MCP', async () => {
  const r = await room();
  const sam = await r.join({ name: 'sam-agent', owner: 'Sam' });
  let session;
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    session ??= res.headers.get('mcp-session-id');
    return (await res.json()).result;
  };
  const tool = async (name, args = {}) => rpc('tools/call', { name, arguments: args });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.ok(session);
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);

  const tools = await rpc('tools/list');
  assert.ok(tools.tools.some((t) => t.name === 'join_room'));

  const early = await tool('send_message', { text: 'hi' });
  assert.equal(early.isError, true);
  assert.match(early.content[0].text, /join_room/);

  const joined = await tool('join_room', { invite: `${base}/join/${r.code}`, name: 'priya-agent', owner: 'Priya' });
  assert.match(joined.content[0].text, /Token: gc_/);
  await tool('send_message', { text: '@sam-agent is Sam free Saturday?' });

  const inbox = await call('/api/inbox?only=mentions', { token: sam.token });
  assert.equal(inbox.data.messages.at(-1).from, 'priya-agent');

  await call('/api/messages', { method: 'POST', token: sam.token, body: { text: '@priya Sam is free Saturday.' } });
  const read = await tool('read_messages', { only_mentions: true });
  assert.match(read.content[0].text, /sam-agent \(Sam's agent\): @priya Sam is free Saturday\./);
  assert.match((await tool('list_members')).content[0].text, /@priya-agent - agent for Priya/);
});

test('rooms, members and unread state survive a restart', async () => {
  const dir = mkdtempSync(path(tmpdir(), 'agentgc-'));
  const one = new Store({ dataDir: dir });
  const r = one.createRoom('kept');
  const a = one.join(r, { name: 'a-agent', owner: 'Ann' });
  const b = one.join(r, { name: 'b-agent', owner: 'Bo' });
  one.post(r, b.member, { text: '@ann hello' });
  one.flush();

  const two = new Store({ dataDir: dir });
  const { room: r2, member } = two.auth(a.token);
  const inbox = await two.inbox(r2, member);
  assert.equal(inbox.mentioned, true);
  assert.equal(inbox.messages.at(-1).text, '@ann hello');
});

test('the command line joins, sends, reads and answers mentions', async () => {
  const r = await room('cli room');
  const priya = await r.join({ name: 'priya-agent', owner: 'Priya' });
  const home = mkdtempSync(path(tmpdir(), 'agentgc-home-'));

  const lost = await cli(['read'], home);
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /Fix: Join one/);

  const joined = await cli(['join', r.invite_url, '--name', 'sam-agent', '--owner', 'Sam'], home);
  assert.match(joined.stdout, /Joined "cli room" as @sam-agent/);
  assert.doesNotMatch(joined.stdout, /gc_/);

  await cli(['send', '@priya', 'is', 'Priya', 'free', 'Friday?'], home);
  const got = await call('/api/inbox', { token: priya.token });
  assert.equal(got.data.messages.at(-1).text, '@priya is Priya free Friday?');

  await call('/api/messages', { method: 'POST', token: priya.token, body: { text: '@sam yes, after 6' } });
  const read = await cli(['read', '--mentions'], home);
  assert.match(read.stdout, /priya-agent \(Priya's agent\): @sam yes, after 6/);

  // listen: run a command for a mention and post what it prints.
  const listener = execFile(process.execPath, [CLI, 'listen', '--exec', 'cat > /dev/null; echo "Sam is free Sunday."'], {
    env: { ...process.env, AGENTGC_HOME: home },
  });
  try {
    const waiting = call('/api/inbox?wait=10&only=all', { token: priya.token });
    await new Promise((res) => setTimeout(res, 400));
    await call('/api/messages', { method: 'POST', token: priya.token, body: { text: '@sam-agent and Sunday?' } });
    const { data } = await waiting;
    assert.equal(data.messages.at(-1).text, 'Sam is free Sunday.');
  } finally {
    listener.kill();
  }
});

// ---- handles: reaching another agent by name --------------------------------

let n = 0;
const uniq = (name) => `${name}-${process.pid}-${++n}`; // handles are relay-wide, and tests share a relay

test('an agent with a handle starts a chat and the invited agent is woken', async () => {
  const [v, p] = [uniq('vedant'), uniq('priya')];
  const vedant = (await call('/api/agents', { method: 'POST', body: { handle: v, owner: 'Vedant' } })).data;
  const priya = (await call('/api/agents', { method: 'POST', body: { handle: `@${p}`, owner: 'Priya', about: "Priya's calendar" } })).data;
  assert.match(vedant.key, new RegExp(`^agc_${v}\\.`));
  assert.ok(vedant.mcp_url.endsWith(`/mcp?key=${vedant.key}`));
  assert.deepEqual((await call(`/api/agents/${p}`)).data, { handle: p, owner: 'Priya', about: "Priya's calendar" });

  // Priya's agent is waiting for anything addressed to it.
  const waiting = call('/api/agent/check?wait=10', { token: priya.key });
  await new Promise((r) => setTimeout(r, 100));
  const started = (await call('/api/agent/chats', {
    method: 'POST', token: vedant.key,
    body: { name: 'dinner plans', invite: [p, 'nobody-has-this'], note: 'is Priya free Friday or Saturday evening?' },
  })).data;
  assert.deepEqual(started.invited, [{ handle: p, owner: 'Priya', about: "Priya's calendar" }]);
  assert.deepEqual(started.not_found, ['nobody-has-this']);
  assert.equal(started.room.name, 'dinner plans');

  const woke = (await waiting).data;
  assert.equal(woke.invites.length, 1);
  assert.equal(woke.invites[0].from, v);
  assert.equal(woke.invites[0].note, 'is Priya free Friday or Saturday evening?');

  const joined = (await call(`/api/agent/invites/${woke.invites[0].id}/accept`, { method: 'POST', token: priya.key })).data;
  assert.deepEqual(joined.members.map((m) => m.handle).sort(), [p, v].sort());
  assert.equal(joined.invited_by.handle, v);

  // Now Vedant's agent waits, and a mention in the chat wakes it through its handle.
  const back = call('/api/agent/check?wait=10', { token: vedant.key });
  await new Promise((r) => setTimeout(r, 100));
  await call('/api/messages', { method: 'POST', token: joined.token, body: { text: `@${v} Priya: Friday busy, Saturday evening free.` } });
  const news = (await back).data;
  assert.equal(news.chats.length, 1);
  assert.equal(news.chats[0].name, 'dinner plans');
  assert.equal(news.chats[0].messages.at(-1).text, `@${v} Priya: Friday busy, Saturday evening free.`);

  // Read once means read, the invite is gone, and a lost token can be had again.
  const quiet = (await call('/api/agent/check', { token: vedant.key })).data;
  assert.deepEqual([quiet.chats, quiet.quiet], [[], ['dinner plans']]);
  const me = (await call('/api/agent', { token: priya.key })).data;
  assert.deepEqual(me.invites, []);
  assert.equal(me.chats[0].token, joined.token);
});

test('handles: taken, wrong key, and a key where a token belongs all say how to fix it', async () => {
  const h = uniq('sam');
  const sam = (await call('/api/agents', { method: 'POST', body: { handle: h, owner: 'Sam' } })).data;
  const cases = [
    await call('/api/agents', { method: 'POST', body: { handle: h, owner: 'Other Sam' } }),
    await call('/api/agents', { method: 'POST', body: { handle: uniq('x') } }),
    await call('/api/agent/check', { token: `agc_${h}.${'A'.repeat(32)}` }),
    await call('/api/agent/check'),
    await call('/api/agents/nobody-has-this'),
    await call('/api/inbox', { token: sam.key }),
    await call('/api/agent/invites/zzz/accept', { method: 'POST', token: sam.key }),
    await call('/api/agent/invites', { method: 'POST', token: sam.key, body: { handles: ['x'] } }),
  ];
  assert.deepEqual(cases.map((c) => c.status), [409, 400, 401, 401, 404, 400, 404, 400]);
  for (const c of cases) assert.ok(c.data.error.code && c.data.error.message && c.data.error.fix, JSON.stringify(c.data));
});

test('over MCP, an agent added with its own URL reaches another by handle with no tokens', async () => {
  const [v, p] = [uniq('vedant'), uniq('priya')];
  const client = (url) => {
    let session;
    let id = 0;
    return async (name, args = {}, method = 'tools/call') => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: method === 'tools/call' ? { name, arguments: args } : args }),
      });
      session ??= res.headers.get('mcp-session-id');
      const { result } = await res.json();
      return method === 'tools/call' ? result.content[0].text : result;
    };
  };

  // Vedant's human claimed a handle on the website and added the URL it gave.
  const made = (await call('/api/agents', { method: 'POST', body: { handle: v, owner: 'Vedant' } })).data;
  const vedant = client(made.mcp_url);
  assert.match((await vedant(null, { protocolVersion: '2025-06-18' }, 'initialize')).instructions, new RegExp(`connected as @${v}`));

  // Priya's agent has plain /mcp and claims a handle itself.
  const priya = client(`${base}/mcp`);
  await priya(null, { protocolVersion: '2025-06-18' }, 'initialize');
  assert.match(await priya('start_chat', { name: 'x' }), /claim_handle/);
  assert.match(await priya('claim_handle', { handle: p, owner: 'Priya' }), new RegExp(`@${p} is yours`));

  assert.match(await vedant('find_agent', { handle: p }), /agent for Priya/);
  const started = await vedant('start_chat', { name: 'Dinner Plans', invite: [`@${p}`], note: 'find an evening' });
  assert.match(started, new RegExp(`Invited: @${p} \\(Priya's agent\\)`));
  await vedant('send_message', { text: `@${p} is Priya free Saturday evening?` });

  const seen = await priya('check');
  assert.match(seen, new RegExp(`"Dinner Plans" from @${v} \\(Vedant's agent\\): find an evening`));
  const joined = await priya('accept_invite', { invite: 'dinner plans' });
  assert.match(joined, /is Priya free Saturday evening\?/);
  await priya('send_message', { text: `@${v} Priya is free Saturday from 7.` });

  assert.match(await vedant('check'), /In "Dinner Plans":[\s\S]*Priya is free Saturday from 7\./);
  assert.match(await vedant('check'), /Nothing new/);

  // A second chat means the agent has to say which one it means.
  await vedant('start_chat', { name: 'movie night' });
  assert.match(await vedant('send_message', { text: 'hi' }), /which_chat/);
  assert.match(await vedant('send_message', { text: 'hi', room: 'movie night' }), /^Sent as #/);
  assert.match(await vedant('leave_room', { room: 'movie night' }), /Left "movie night"/);
  assert.match(await vedant('list_members'), new RegExp(`@${p} - agent for Priya`));
});

test('the command line signs up, starts a chat by handle, and the other side accepts', async () => {
  const [v, p] = [uniq('vedant'), uniq('priya')];
  const [vHome, pHome] = [mkdtempSync(path(tmpdir(), 'agentgc-v-')), mkdtempSync(path(tmpdir(), 'agentgc-p-'))];
  const up = await cli(['signup', v, '--owner', 'Vedant', '--server', base], vHome);
  assert.match(up.stdout, new RegExp(`@${v} is yours`));
  assert.doesNotMatch(up.stdout, /agc_/);
  await cli(['signup', p, '--owner', 'Priya', '--server', base], pHome);

  const chat = await cli(['chat', 'dinner', 'plans', '--with', `${p},ghost-handle`, '--note', 'when is Priya free?'], vHome);
  assert.match(chat.stdout, new RegExp(`Invited: @${p} \\(Priya's agent\\)`));
  assert.match(chat.stdout, /No such handle: @ghost-handle/);
  await cli(['send', `@${p}`, 'Friday', 'or', 'Saturday?'], vHome);

  const check = await cli(['check'], pHome);
  const inviteId = /- (\S+): "dinner plans" from/.exec(check.stdout)?.[1];
  assert.ok(inviteId, check.stdout + check.stderr);
  const accepted = await cli(['accept', inviteId], pHome);
  assert.match(accepted.stdout, /Friday or Saturday\?/);
  await cli(['send', `@${v}`, 'Saturday'], pHome);
  assert.match((await cli(['check'], vHome)).stdout, /Priya's agent\): @\S+ Saturday/);
});

test('handles and their chats survive a restart', async () => {
  const dir = mkdtempSync(path(tmpdir(), 'agentgc-'));
  const one = createApp({ dataDir: dir });
  const made = await one.app.claim('http://x', { handle: 'kept', owner: 'Kay' });
  await one.app.startChat('http://x', made.key, { name: 'still here' });
  await one.close();
  const two = createApp({ dataDir: dir });
  const me = await two.app.me('http://x', made.key);
  assert.deepEqual(me.chats.map((c) => c.name), ['still here']);
  await two.close();
});
