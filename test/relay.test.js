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

const claim = async (handle, owner, about) => (await call('/api/agents', { method: 'POST', body: { handle, owner, about } })).data;
const asId = (tag) => tag.replace('#', '-'); // how a handle is written in a URL

test('an agent with a handle starts a chat and the invited agent is woken', async () => {
  const vedant = await claim('vedant', 'Vedant');
  const priya = await claim('@Priya', 'Priya', "Priya's calendar");
  assert.match(vedant.handle, /^vedant#\d{4}$/);
  assert.match(priya.handle, /^priya#\d{4}$/);
  assert.ok(vedant.key.startsWith(`agc_${asId(vedant.handle)}.`));
  assert.ok(vedant.mcp_url.endsWith(`/mcp?key=${vedant.key}`));
  assert.deepEqual((await call(`/api/agents/${asId(priya.handle)}`)).data, { handle: priya.handle, owner: 'Priya', about: "Priya's calendar" });
  assert.deepEqual((await call(`/api/agents/${encodeURIComponent(priya.handle)}`)).data.owner, 'Priya');

  // Priya's agent is waiting for anything addressed to it.
  const waiting = call('/api/agent/check?wait=10', { token: priya.key });
  await new Promise((r) => setTimeout(r, 100));
  const started = (await call('/api/agent/chats', {
    method: 'POST', token: vedant.key,
    body: { name: 'dinner plans', invite: [priya.handle, 'nobody#1234'], note: 'is Priya free Friday or Saturday evening?' },
  })).data;
  assert.deepEqual(started.invited, [{ handle: priya.handle, owner: 'Priya', about: "Priya's calendar" }]);
  assert.deepEqual(started.not_found, ['nobody-1234']);
  assert.deepEqual(started.already, []);
  assert.equal(started.room.name, 'dinner plans');
  assert.equal(started.you.name, 'vedant');

  const woke = (await waiting).data;
  assert.equal(woke.invites.length, 1);
  assert.equal(woke.invites[0].from, vedant.handle);
  assert.equal(woke.invites[0].note, 'is Priya free Friday or Saturday evening?');

  const joined = (await call(`/api/agent/invites/${woke.invites[0].id}/accept`, { method: 'POST', token: priya.key })).data;
  assert.deepEqual(joined.members.map((m) => [m.name, m.handle]).sort(), [['priya', priya.handle], ['vedant', vedant.handle]]);
  assert.equal(joined.invited_by.handle, vedant.handle);

  // Now Vedant's agent waits, and a mention in the chat wakes it through its handle.
  const back = call('/api/agent/check?wait=10', { token: vedant.key });
  await new Promise((r) => setTimeout(r, 100));
  await call('/api/messages', { method: 'POST', token: joined.token, body: { text: '@vedant Priya: Friday busy, Saturday evening free.' } });
  const news = (await back).data;
  assert.equal(news.chats.length, 1);
  assert.equal(news.chats[0].name, 'dinner plans');
  assert.equal(news.chats[0].messages.at(-1).text, '@vedant Priya: Friday busy, Saturday evening free.');

  // Read once means read, the invite is gone, and a lost token can be had again.
  const quiet = (await call('/api/agent/check', { token: vedant.key })).data;
  assert.deepEqual([quiet.chats, quiet.quiet], [[], ['dinner plans']]);
  const me = (await call('/api/agent', { token: priya.key })).data;
  assert.deepEqual(me.invites, []);
  assert.equal(me.chats[0].token, joined.token);
});

test('contacts fill in as agents meet, and then a first name is enough', async () => {
  const vedant = await claim('vedant', 'Vedant');
  const priya = await claim('priya', 'Priya', "Priya's calendar");
  const other = await claim('priya', 'Priya Rao');
  const sam = await claim('sam', 'Sam');
  assert.notEqual(priya.handle, other.handle); // two Priyas, two codes

  // Nobody is a contact yet, so a first name is not enough.
  const first = (await call('/api/agent/chats', { method: 'POST', token: vedant.key, body: { name: 'one', invite: ['Priya'] } })).data;
  assert.deepEqual([first.invited, first.not_found], [[], ['priya']]);

  // Vedant's human says "Priya's agent is priya#....".
  const added = await call('/api/agent/contacts', { method: 'POST', token: vedant.key, body: { handle: priya.handle, note: 'college friend' } });
  assert.deepEqual(added.data.added, { handle: priya.handle, owner: 'Priya', about: "Priya's calendar", note: 'college friend' });
  const second = (await call('/api/agent/chats', { method: 'POST', token: vedant.key, body: { name: 'two', invite: ['Priya', sam.handle] } })).data;
  assert.deepEqual(second.invited.map((p) => p.handle), [priya.handle, sam.handle]);

  // Both sides now know each other, and the list reads as a file an agent can keep.
  const mine = await call('/api/agent/contacts.md', { token: vedant.key });
  assert.match(mine.headers.get('content-type'), /text\/markdown/);
  assert.ok(mine.data.includes(`| Priya | ${priya.handle} | college friend. Priya's calendar |`), mine.data);
  assert.ok(mine.data.includes(`| Sam | ${sam.handle} |`));
  assert.ok(mine.data.includes(`Your own handle is \`${vedant.handle}\``));
  const theirs = (await call('/api/agent/contacts', { token: sam.key })).data;
  assert.deepEqual(theirs.contacts.map((c) => c.handle), [vedant.handle]);

  // With two Priyas in the contacts, the name alone is not enough and the reply says who it could be.
  await call('/api/agent/contacts', { method: 'POST', token: vedant.key, body: { handle: other.handle } });
  const third = (await call('/api/agent/chats', { method: 'POST', token: vedant.key, body: { name: 'three', invite: ['priya'] } })).data;
  assert.deepEqual(third.invited, []);
  assert.deepEqual(third.unclear[0].matches.map((m) => m.handle).sort(), [priya.handle, other.handle].sort());
});

test('handles: wrong key, unknown handle, and a key where a token belongs all say how to fix it', async () => {
  const sam = await claim('sam', 'Sam');
  const cases = [
    await call('/api/agents', { method: 'POST', body: { handle: 'sam' } }),
    await call('/api/agents', { method: 'POST', body: { handle: '!', owner: 'Sam' } }),
    await call('/api/agent/check', { token: `agc_${asId(sam.handle)}.${'A'.repeat(32)}` }),
    await call('/api/agent/check'),
    await call('/api/agents/sam'),
    await call('/api/inbox', { token: sam.key }),
    await call('/api/agent/invites/zzz/accept', { method: 'POST', token: sam.key }),
    await call('/api/agent/invites', { method: 'POST', token: sam.key, body: { handles: ['x'] } }),
    await call('/api/agent/contacts', { method: 'POST', token: sam.key, body: { handle: 'ghost#0000' } }),
    await call('/api/agent/contacts', { method: 'POST', token: sam.key, body: { handle: sam.handle } }),
  ];
  assert.deepEqual(cases.map((c) => c.status), [400, 400, 401, 401, 404, 400, 404, 400, 404, 400]);
  for (const c of cases) assert.ok(c.data.error.code && c.data.error.message && c.data.error.fix, JSON.stringify(c.data));
});

test('over MCP, an agent added with its own URL reaches another by handle with no tokens', async () => {
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
  const made = await claim('vedant', 'Vedant');
  const vedant = client(made.mcp_url);
  assert.ok((await vedant(null, { protocolVersion: '2025-06-18' }, 'initialize')).instructions.includes(`connected as ${made.handle}`));

  // Priya's agent has plain /mcp and claims a handle itself.
  const priya = client(`${base}/mcp`);
  await priya(null, { protocolVersion: '2025-06-18' }, 'initialize');
  assert.match(await priya('start_chat', { name: 'x' }), /claim_handle/);
  const tag = /^(priya#\d{4}) is yours/.exec(await priya('claim_handle', { handle: 'priya', owner: 'Priya' }))?.[1];
  assert.ok(tag);

  // Vedant's human passes on Priya's handle; after that her name is enough.
  assert.match(await vedant('start_chat', { name: 'too early', invite: ['Priya'] }), /Could not find: priya\. They are not in your contacts/);
  await vedant('leave_room');
  assert.match(await vedant('find_agent', { handle: tag }), /agent for Priya/);
  assert.match(await vedant('add_contact', { handle: tag }), /You can now invite them as "Priya"/);
  const started = await vedant('start_chat', { name: 'Dinner Plans', invite: ['Priya'], note: 'find an evening' });
  assert.ok(started.includes(`Invited: ${tag} (Priya's agent)`), started);
  await vedant('send_message', { text: '@priya is Priya free Saturday evening?' });

  const seen = await priya('check');
  assert.ok(seen.includes(`"Dinner Plans" from ${made.handle} (Vedant's agent): find an evening`), seen);
  const joined = await priya('accept_invite', { invite: 'dinner plans' });
  assert.match(joined, /is Priya free Saturday evening\?/);
  await priya('send_message', { text: '@vedant Priya is free Saturday from 7.' });
  assert.ok((await priya('contacts')).includes(`| Vedant | ${made.handle} |`));

  assert.match(await vedant('check'), /In "Dinner Plans":[\s\S]*Priya is free Saturday from 7\./);
  assert.match(await vedant('check'), /Nothing new/);

  // A second chat means the agent has to say which one it means.
  await vedant('start_chat', { name: 'movie night' });
  assert.match(await vedant('send_message', { text: 'hi' }), /which_chat/);
  assert.match(await vedant('send_message', { text: 'hi', room: 'movie night' }), /^Sent as #/);
  assert.match(await vedant('leave_room', { room: 'movie night' }), /Left "movie night"/);
  assert.match(await vedant('list_members'), /@priya - agent for Priya/);
});

test('the command line signs up, starts a chat by handle, and the other side accepts', async () => {
  const [vHome, pHome] = [mkdtempSync(path(tmpdir(), 'agentgc-v-')), mkdtempSync(path(tmpdir(), 'agentgc-p-'))];
  const up = await cli(['signup', 'vedant', '--owner', 'Vedant', '--server', base], vHome);
  assert.match(up.stdout, /^vedant#\d{4} is yours/);
  assert.doesNotMatch(up.stdout, /agc_/);
  const tag = /^(priya#\d{4}) is yours/.exec((await cli(['signup', 'priya', '--owner', 'Priya', '--server', base], pHome)).stdout)[1];

  const chat = await cli(['chat', 'dinner', 'plans', '--with', `${tag},ghost`, '--note', 'when is Priya free?'], vHome);
  assert.ok(chat.stdout.includes(`Invited: ${tag} (Priya's agent)`), chat.stdout + chat.stderr);
  assert.match(chat.stdout, /Could not find: ghost/);
  await cli(['send', '@priya', 'Friday', 'or', 'Saturday?'], vHome);
  assert.ok((await cli(['contacts'], vHome)).stdout.includes(`| Priya | ${tag} |`));

  const check = await cli(['check'], pHome);
  const inviteId = /- (\S+): "dinner plans" from/.exec(check.stdout)?.[1];
  assert.ok(inviteId, check.stdout + check.stderr);
  const accepted = await cli(['accept', inviteId], pHome);
  assert.match(accepted.stdout, /Friday or Saturday\?/);
  await cli(['send', '@vedant', 'Saturday'], pHome);
  assert.match((await cli(['check'], vHome)).stdout, /Priya's agent\): @vedant Saturday/);
});

test('handles, their chats and their contacts survive a restart', async () => {
  const dir = mkdtempSync(path(tmpdir(), 'agentgc-'));
  const one = createApp({ dataDir: dir });
  const kay = await one.app.claim('http://x', { handle: 'kay', owner: 'Kay' });
  const lee = await one.app.claim('http://x', { handle: 'lee', owner: 'Lee' });
  await one.app.startChat('http://x', kay.key, { name: 'still here', invite: [lee.handle] });
  await one.close();
  const two = createApp({ dataDir: dir });
  const me = await two.app.me('http://x', kay.key);
  assert.deepEqual(me.chats.map((c) => c.name), ['still here']);
  assert.deepEqual(me.contacts.map((c) => c.handle), [lee.handle]);
  await two.close();
});
