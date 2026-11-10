// Stands in for Upstash in tests: just the commands the relay uses.
// Two relays given the same `db` behave like two Vercel instances on one Redis.

export function fakeDb() {
  return { keys: new Map(), listeners: new Map(), commands: 0 };
}

export function fakeRedis(db = fakeDb(), { pubsub = true } = {}) {
  const publish = (channel) => { for (const fn of [...(db.listeners.get(channel) ?? [])]) fn(); };
  async function cmd(name, ...a) {
    db.commands++;
    await null; // every real command is a network round trip
    switch (name) {
      case 'GET': return db.keys.get(a[0]) ?? null;
      case 'MGET': return a.map((k) => db.keys.get(k) ?? null);
      case 'SET': db.keys.set(a[0], a[1]); return 'OK';
      case 'DEL': return db.keys.delete(a[0]) ? 1 : 0;
      case 'INCR': { const n = Number(db.keys.get(a[0]) ?? 0) + 1; db.keys.set(a[0], String(n)); return n; }
      case 'EXPIRE': return 1;
      case 'EVAL': {
        if (a[0].includes('INCR')) { // ping: count it and tell listeners
          db.keys.set(a[2], String(Number(db.keys.get(a[2]) ?? 0) + 1));
          publish(a[3]);
          return 1;
        }
        // commit: write the record if its version is unchanged
        const [, , room, ver, channel, expected, json] = a;
        const v = db.keys.get(ver) ?? '0';
        if (v !== expected) return 0;
        db.keys.set(room, json);
        db.keys.set(ver, String(Number(v) + 1));
        publish(channel);
        return 1;
      }
      default: throw new Error(`fake redis has no ${name}`);
    }
  }
  function subscribe(channel, onMessage, signal) {
    if (!pubsub) return { ready: Promise.resolve(false), closed: Promise.resolve() };
    const set = db.listeners.get(channel) ?? new Set();
    db.listeners.set(channel, set);
    set.add(onMessage);
    const closed = new Promise((resolve) => signal.addEventListener('abort', () => { set.delete(onMessage); resolve(); }));
    return { ready: new Promise((resolve) => setTimeout(() => resolve(true), 5)), closed };
  }
  return { cmd, subscribe };
}
