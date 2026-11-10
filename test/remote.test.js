// The relay with rooms in Redis, as it runs on Vercel: every request may land
// on a different process that remembers nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/relay.js';
import { fakeDb, fakeRedis } from './fake-redis.js';

process.env.AGENTGC_TEST_REMOTE = '1';
await import('./relay.test.js'); // everything the in-memory relay does, again

async function pair(options) {
  const db = fakeDb();
  const relays = [createApp({ redis: fakeRedis(db, options), pollMs: 150 }), createApp({ redis: fakeRedis(db, options), pollMs: 150 })];
  const bases = await Promise.all(relays.map(async (r) => `http://localhost:${await r.listen(0)}`));
  const call = async (i, path, { method = 'GET', token, body } = {}) => {
    const res = await fetch(bases[i] + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  return { db, bases, call, close: () => Promise.all(relays.map((r) => r.close())) };
}

for (const [label, options] of [['with pub/sub', {}], ['falling back to checking on a timer', { pubsub: false }]]) {
  test(`an invite and a mention sent through one instance wake a handle waiting on another, ${label}`, async () => {
    const { call, close } = await pair(options);
    try {
      const vedant = (await call(0, '/api/agents', { method: 'POST', body: { handle: 'vedant', owner: 'Vedant' } })).data;
      const priya = (await call(1, '/api/agents', { method: 'POST', body: { handle: 'priya', owner: 'Priya' } })).data;

      const invited = call(1, '/api/agent/check?wait=10', { token: priya.key });
      await new Promise((r) => setTimeout(r, 100));
      let started = Date.now();
      const chat = (await call(0, '/api/agent/chats', { method: 'POST', token: vedant.key, body: { name: 'dinner plans', invite: ['priya'] } })).data;
      const { data: woke } = await invited;
      assert.equal(woke.invites[0].room, 'dinner plans');
      assert.ok(Date.now() - started < 2000, `woken in ${Date.now() - started} ms`);
      const joined = (await call(1, `/api/agent/invites/${woke.invites[0].id}/accept`, { method: 'POST', token: priya.key })).data;

      const answered = call(0, '/api/agent/check?wait=10', { token: vedant.key });
      await new Promise((r) => setTimeout(r, 100));
      started = Date.now();
      await call(1, '/api/messages', { method: 'POST', token: joined.token, body: { text: '@vedant Saturday works' } });
      const { data: news } = await answered;
      assert.equal(news.chats[0].messages.at(-1).text, '@vedant Saturday works');
      assert.ok(Date.now() - started < 2000, `woken in ${Date.now() - started} ms`);
      assert.equal(chat.room.code, news.chats[0].code);
    } finally {
      await close();
    }
  });

  test(`a mention sent through one instance wakes an agent waiting on another, ${label}`, async () => {
    const { call, close } = await pair(options);
    try {
      const room = (await call(0, '/api/rooms', { method: 'POST', body: { name: 'two instances' } })).data;
      const sam = (await call(0, `/api/rooms/${room.code}/join`, { method: 'POST', body: { name: 'sam-agent', owner: 'Sam' } })).data;
      const priya = (await call(1, `/api/rooms/${room.code}/join`, { method: 'POST', body: { name: 'priya-agent', owner: 'Priya' } })).data;

      const waiting = call(0, '/api/inbox?wait=10&only=mentions', { token: sam.token });
      await new Promise((r) => setTimeout(r, 100));
      const started = Date.now();
      await call(1, '/api/messages', { method: 'POST', token: priya.token, body: { text: '@sam free Friday?' } });
      const { data } = await waiting;
      assert.equal(data.mentioned, true);
      assert.equal(data.messages.at(-1).text, '@sam free Friday?');
      assert.ok(Date.now() - started < 1500, 'woken promptly');

      const again = await call(1, '/api/inbox', { token: sam.token });
      assert.deepEqual(again.data.messages, []);
    } finally {
      await close();
    }
  });
}

test('messages posted at the same moment through different instances all land, in order', async () => {
  const { call, close } = await pair();
  try {
    const room = (await call(0, '/api/rooms', { method: 'POST', body: { name: 'busy' } })).data;
    const members = [];
    for (let i = 0; i < 6; i++) {
      members.push((await call(i % 2, `/api/rooms/${room.code}/join`, { method: 'POST', body: { name: `a${i}-agent`, owner: `P${i}` } })).data);
    }
    const sent = await Promise.all(members.map((m, i) => call(i % 2, '/api/messages', { method: 'POST', token: m.token, body: { text: `hello ${i}` } })));
    assert.deepEqual(sent.map((s) => s.status), [201, 201, 201, 201, 201, 201]);
    const { data } = await call(0, `/api/rooms/${room.code}/messages`);
    const texts = data.messages.filter((m) => m.kind === 'agent');
    assert.equal(texts.length, 6);
    const ids = data.messages.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    await close();
  }
});

test('a watching browser is sent what it missed, then new messages as they arrive', async () => {
  const { bases, call, close } = await pair();
  try {
    const room = (await call(0, '/api/rooms', { method: 'POST', body: { name: 'watched' } })).data;
    const sam = (await call(0, `/api/rooms/${room.code}/join`, { method: 'POST', body: { name: 'sam-agent', owner: 'Sam' } })).data;
    await call(0, '/api/messages', { method: 'POST', token: sam.token, body: { text: 'one' } });

    const abort = new AbortController();
    const res = await fetch(`${bases[1]}/api/rooms/${room.code}/events?after=0`, { signal: abort.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    let seen = '';
    const reading = (async () => {
      try { for await (const chunk of res.body) seen += Buffer.from(chunk).toString(); } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 200));
    await call(0, '/api/messages', { method: 'POST', token: sam.token, body: { text: 'two' } });
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    await reading;
    assert.match(seen, /event: message\ndata: .*"text":"one"/);
    assert.match(seen, /event: message\ndata: .*"text":"two"/);
    assert.match(seen, /event: members/);
    assert.equal((await fetch(`${bases[1]}/api/rooms/nope/events`)).status, 404);
  } finally {
    await close();
  }
});

test('waiting in an idle room costs a handful of Redis commands, not one per second', async () => {
  const { db, call, close } = await pair();
  try {
    const room = (await call(0, '/api/rooms', { method: 'POST', body: { name: 'quiet' } })).data;
    const sam = (await call(0, `/api/rooms/${room.code}/join`, { method: 'POST', body: { name: 'sam-agent', owner: 'Sam' } })).data;
    const before = db.commands;
    const { data } = await call(1, '/api/inbox?wait=2&only=mentions', { token: sam.token });
    assert.deepEqual(data.messages, []);
    assert.ok(db.commands - before <= 4, `used ${db.commands - before} commands`);
  } finally {
    await close();
  }
});
