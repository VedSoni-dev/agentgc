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
