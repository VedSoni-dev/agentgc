// Rooms kept in Redis instead of memory, for hosts where every request may
// land on a different short-lived process (Vercel). Each request loads its
// room, changes it with the same Store code the in-memory relay uses, and
// writes it back only if nobody else wrote first.

import { Store, GcError } from './store.js';

const DAY = 86_400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Write the room only if its version is still the one we read, then tell listeners.
const COMMIT = `
local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[2], tostring(tonumber(v) + 1), 'EX', ARGV[3])
redis.call('PUBLISH', KEYS[3], '1')
return 1`;

// Tell whoever is waiting on an account that something happened in one of its chats.
const PING = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[2], '1')
return 1`;

export function createRemote(redis, { keepDays = 30, kept = 500, pollMs = 3000 } = {}) {
  const key = (code, part) => `agc:{${code}}:${part}`;
  const ttl = String(keepDays * DAY);
  const docTtl = String(365 * DAY); // handles outlive rooms
  const parse = (json) => (typeof json === 'string' ? JSON.parse(json) : json);
  // This process just changed something: wake its own waiters if no subscription will.
  const nudge = (code) => {
    const w = watchers.get(code);
    if (w && !w.live) w.bump();
  };
  const watchers = new Map(); // room code -> the one subscription this process holds for it

  /**
   * Load the room, run `fn(store)`, and save if it changed anything.
   * `fn` may run more than once: if another request wrote first, we start over.
   */
  async function run(code, fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const store = new Store({ kept });
      let dirty = false;
      store.save = () => { dirty = true; };
      const mentioned = new Set(); // handles of members a new message addresses
      store.onMessage = (room, msg) => {
        for (const mid of msg.to) {
          const m = room.members.get(mid);
          if (m?.account && !m.left) mentioned.add(m.account);
        }
      };
      let version = '0';
      if (code) {
        const [json, ver] = await redis.cmd('MGET', key(code, 'room'), key(code, 'ver'));
        if (json) {
          store.importRoom(parse(json));
          version = String(ver ?? '0');
        }
      }
      const value = await fn(store);
      const room = store.rooms.values().next().value;
      if (!dirty || !room) return { value, version };
      const saved = await redis.cmd('EVAL', COMMIT, '3',
        key(room.code, 'room'), key(room.code, 'ver'), key(room.code, 'ch'),
        version, JSON.stringify(store.exportRoom(room, true)), ttl);
      if (saved === 1) {
        nudge(room.code);
        await Promise.all([...mentioned].map((h) => ping(`@${h}`).catch(() => {})));
        return { value, version: String(Number(version) + 1) };
      }
      await sleep(10 + Math.random() * 30 * (attempt + 1));
    }
    throw new GcError(503, 'room_busy', 'The room is too busy to take that right now.', 'Send the same request again in a second.');
  }

  /**
   * One small record outside any room (an account, kept under "@handle").
   * `fn(current or null)` returns { value, save }: `save` is the new record, or leave it out to write nothing.
   */
  async function doc(id, fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const [json, ver] = await redis.cmd('MGET', key(id, 'doc'), key(id, 'ver'));
      const out = (await fn(json ? parse(json) : null)) ?? {};
      if (out.save === undefined) return out.value;
      const saved = await redis.cmd('EVAL', COMMIT, '3',
        key(id, 'doc'), key(id, 'ver'), key(id, 'ch'), String(ver ?? '0'), JSON.stringify(out.save), docTtl);
      if (saved === 1) {
        nudge(id);
        return out.value;
      }
      await sleep(10 + Math.random() * 30 * (attempt + 1));
    }
    throw new GcError(503, 'busy', 'Too much is changing at once to take that right now.', 'Send the same request again in a second.');
  }

  /** Wake whoever waits on `id` without changing its record. */
  async function ping(id) {
    await redis.cmd('EVAL', PING, '2', key(id, 'n'), key(id, 'ch'), docTtl);
    nudge(id);
  }

  /** Changes whenever the record under `id` is written or pinged. One command, so cheap to check on a timer. */
  async function stamp(id) {
    const [ver, n] = await redis.cmd('MGET', key(id, 'ver'), key(id, 'n'));
    return `${ver ?? 0}:${n ?? 0}`;
  }

  /** Start (or share) this process's subscription to a room. Pair with release(). */
  function hold(code) {
    let w = watchers.get(code);
    if (!w) {
      const abort = new AbortController();
      w = { code, refs: 0, tick: 0, live: false, waiters: new Set(), abort };
      w.bump = () => {
        w.tick++;
        for (const wake of [...w.waiters]) wake();
      };
      const sub = redis.subscribe(key(code, 'ch'), w.bump, abort.signal);
      w.ready = sub.ready.then((ok) => { w.live = ok; return ok; });
      const mine = w;
      sub.closed.then(() => {
        mine.live = false;
        if (watchers.get(code) === mine) watchers.delete(code);
        mine.bump();
      });
      watchers.set(code, w);
    }
    w.refs++;
    return w;
  }

  function release(w) {
    if (--w.refs > 0) return;
    w.abort.abort();
    if (watchers.get(w.code) === w) watchers.delete(w.code);
  }

  /** Resolve when the room has changed since `tick`, or after `ms`. Without a live subscription, check back sooner. */
  function wait(w, tick, ms, signal) {
    if (w.tick !== tick || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        w.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, w.live ? ms : Math.min(ms, pollMs));
      w.waiters.add(done);
      signal?.addEventListener('abort', done);
    });
  }

  /** Count an event under `name` in the current window; returns the count so far. */
  async function count(name, seconds) {
    const k = `agc:count:${name}:${Math.floor(Date.now() / 1000 / seconds)}`;
    const n = await redis.cmd('INCR', k);
    if (n === 1) await redis.cmd('EXPIRE', k, String(seconds));
    return n;
  }

  const sessions = {
    async get(id) { return (await redis.cmd('GET', `agc:mcp:${id}`)) || null; },
    async set(id, token) {
      if (token) await redis.cmd('SET', `agc:mcp:${id}`, token, 'EX', String(7 * DAY));
      else await redis.cmd('DEL', `agc:mcp:${id}`);
    },
    async delete(id) { await redis.cmd('DEL', `agc:mcp:${id}`); },
  };

  return { run, doc, ping, stamp, hold, release, wait, count, sessions, sleep, keepDays, kept };
}
