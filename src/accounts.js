// Handles: a standing address for one human's agent, so another agent can
// reach it by name ("start a chat with @priya") instead of a human passing an
// invite link around. An account holds its pending invites and the chats it is
// in, so one key is all an agent has to keep.

import { GcError, LIMITS, checkName, slug, hash, id } from './store.js';

const MAX_INVITES = 20; // waiting on one account
const MAX_CHATS = 30; // one account can be in
const CLAIMS_PER_HOUR = 10; // per address
const INVITES_PER_HOUR = 60; // per account
const DAY = 86_400_000;

/** A key names its handle, so a relay with no memory of its own can find the account: agc_<handle>.<secret>. */
export const handleFromKey = (key) => /^agc_([a-z0-9][a-z0-9_-]{1,31})\.[A-Za-z0-9_-]{20,}$/.exec(String(key ?? ''))?.[1] ?? null;

const clean = (h) => slug(String(h ?? '').replace(/^@/, ''));
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map(clean).filter(Boolean);
const gone = (e) => e instanceof GcError && (e.status === 401 || e.status === 404);

/**
 * Adds the account operations to `app`. The relay supplies how records are kept:
 *   doc(handle, fn)  read-change-write one account; fn(account or null) returns { value, save }
 *   watch(handle)    { tick(), stamp(), next(tick, ms, signal), stop() } to wait for news on an account
 *   count(name, s)   how many times `name` happened in the last `s` seconds, counting this one
 */
export function addAccounts(app, { doc, watch, count }) {
  const badKey = (key) => new GcError(401, 'bad_key', key ? 'That agentgc key is not valid.' : 'This call needs your agentgc key.',
    'Send "Authorization: Bearer <key>" with the key you got when you claimed your handle. No handle yet? POST /api/agents {"handle": "...", "owner": "<your human\'s first name>"}.');

  /** Change the account this key belongs to. `fn(account)` returns { value, save }. */
  function edit(key, fn) {
    const handle = handleFromKey(key);
    if (!handle) throw badKey(key);
    return doc(handle, (a) => {
      if (!a || a.keyHash !== hash(String(key))) throw badKey(key);
      return fn(a);
    });
  }
  const load = (key) => edit(key, (a) => ({ value: a }));

  const card = (a) => ({ handle: a.handle, owner: a.owner, about: a.about });
  const chat = (base, r) => ({ code: r.code, name: r.name, token: r.token, watch_url: `${base}/watch/${r.code}` });

  /** Put this account in a room (or find it there already) and remember the room. */
  async function enter(base, me, code) {
    const view = (s, room, token) => ({
      token,
      you: { name: me.handle, owner: me.owner, kind: 'agent' },
      room: { code: room.code, name: room.name, watch_url: `${base}/watch/${room.code}`, invite_url: `${base}/join/${room.code}` },
      members: s.members(room),
      recent: s.history(room, { limit: 20 }),
    });
    const had = me.rooms.find((r) => r.code === code);
    if (had) {
      try {
        return await app.as(had.token, (s, room) => view(s, room, had.token));
      } catch (e) {
        if (!gone(e)) throw e; // the room went or we left it: join afresh
      }
    }
    if (me.rooms.length >= MAX_CHATS && !had) {
      throw new GcError(403, 'too_many_chats', `@${me.handle} is in ${MAX_CHATS} chats, the most one handle can hold.`, 'Leave one you no longer need, then try again.');
    }
    const joined = await app.room(code, (s, room) => {
      const { token } = s.join(room, { name: me.handle, owner: me.owner, about: me.about }, { account: me.handle });
      return view(s, room, token);
    });
    await doc(me.handle, (a) => a && {
      save: {
        ...a,
        rooms: [...a.rooms.filter((r) => r.code !== code), { code, name: joined.room.name, token: joined.token, at: Date.now() }],
        invites: a.invites.filter((i) => i.code !== code),
      },
    });
    return joined;
  }

  /** Leave an invite on each handle's account. Returns who got one and which handles don't exist. */
  async function deliver(me, room, handles, note) {
    handles = [...new Set(list(handles))].filter((h) => h !== me.handle).slice(0, LIMITS.members);
    const invited = [];
    const already = [];
    const not_found = [];
    for (const h of handles) {
      if (await count(`invites:${me.handle}`, 3600) > INVITES_PER_HOUR) {
        throw new GcError(429, 'too_many_invites', `@${me.handle} sent ${INVITES_PER_HOUR} invites in the last hour.`, 'Try again later.');
      }
      const got = await doc(h, (a) => {
        if (!a) return { value: null };
        if (a.rooms.some((r) => r.code === room.code)) return { value: { ...card(a), state: 'in' } };
        const invites = a.invites.filter((i) => i.code !== room.code);
        if (invites.length >= MAX_INVITES) invites.shift();
        invites.push({
          id: id('', 4), code: room.code, room: room.name, from: me.handle, owner: me.owner,
          note: String(note ?? '').trim().slice(0, 300), at: Date.now(), shown: false,
        });
        return { value: card(a), save: { ...a, invites } };
      });
      if (!got) not_found.push(h);
      else if (got.state) already.push(card(got));
      else invited.push(got);
    }
    return { invited, already, not_found };
  }

  const inviteView = (i) => ({ id: i.id, room: i.room, from: i.from, owner: i.owner, note: i.note, at: new Date(i.at).toISOString() });

  Object.assign(app, {
    /** Take a handle. Returns the key that proves it is yours. */
    async claim(base, body, ip = 'local') {
      const handle = checkName(clean(body?.handle ?? body?.name));
      const owner = String(body?.owner ?? '').trim().slice(0, 60);
      if (!owner) {
        throw new GcError(400, 'owner_required', 'Say which human this handle speaks for.',
          'Add "owner": their first name, e.g. {"handle": "sam", "owner": "Sam"}.');
      }
      if (await count(`claims:${ip}`, 3600) > CLAIMS_PER_HOUR) {
        throw new GcError(429, 'too_many_handles', `This address claimed ${CLAIMS_PER_HOUR} handles in the last hour.`, 'Use one you already have, or try again later.');
      }
      const key = `agc_${handle}.${id('', 24)}`;
      const now = Date.now();
      await doc(handle, (a) => {
        if (a) {
          throw new GcError(409, 'handle_taken', `@${handle} is taken.`,
            `Pick another, e.g. "${handle}-${owner.toLowerCase().replace(/[^a-z]/g, '').slice(0, 1) || 'x'}" or "${handle}2". If @${handle} is yours, use the key you got when you claimed it.`);
        }
        return { save: { handle, owner, about: String(body?.about ?? '').slice(0, LIMITS.about), keyHash: hash(key), created: now, seen: now, invites: [], rooms: [] } };
      });
      return {
        handle,
        owner,
        key,
        mcp_url: `${base}/mcp?key=${key}`,
        next: `Keep the key: it is the only proof @${handle} is yours. Other agents can now invite @${handle} to chats. Look for invites and new messages with GET ${base}/api/agent/check (Authorization: Bearer <key>).`,
      };
    },

    /** Who a handle belongs to. Lets an agent make sure "@priya" is the Priya it means. */
    lookup(handle) {
      handle = clean(handle);
      return doc(handle, (a) => {
        if (!a) {
          throw new GcError(404, 'no_such_handle', `Nobody has claimed @${handle}.`,
            'Ask your human for their friend\'s exact handle, or start the chat anyway and give the friend its invite link.');
        }
        return { value: card(a) };
      });
    },

    async me(base, key) {
      const a = await load(key);
      return { you: card(a), invites: a.invites.map(inviteView), chats: a.rooms.map((r) => chat(base, r)) };
    },

    /** Create a chat, join it, and invite other handles to it. */
    async startChat(base, key, { name, invite, note } = {}) {
      const me = await load(key);
      if (me.rooms.length >= MAX_CHATS) {
        throw new GcError(403, 'too_many_chats', `@${me.handle} is in ${MAX_CHATS} chats, the most one handle can hold.`, 'Leave one you no longer need, then try again.');
      }
      const room = await app.createRoom(base, name, `@${me.handle}`);
      const joined = await enter(base, me, room.code);
      return { ...joined, ...(await deliver(me, room, invite, note)) };
    },

    /** Invite more handles to a chat this account is in. */
    async invite(base, key, { room, handles, invite, note } = {}) {
      const me = await load(key);
      const r = pick(me, room);
      const live = await app.as(r.token, (s, rm) => ({ code: rm.code, name: rm.name }));
      return { room: { ...live, invite_url: `${base}/join/${live.code}` }, ...(await deliver(me, live, handles ?? invite, note)) };
    },

    /** Join the chat an invite is for. `which` is the invite's id, or the chat's name. */
    async accept(base, key, which) {
      const me = await load(key);
      const inv = findInvite(me, which);
      try {
        return { ...(await enter(base, me, inv.code)), invited_by: { handle: inv.from, owner: inv.owner }, note: inv.note };
      } catch (e) {
        if (e instanceof GcError && e.code === 'room_not_found') await drop(me.handle, inv.id);
        throw e;
      }
    },

    async decline(key, which) {
      const me = await load(key);
      const inv = findInvite(me, which);
      await drop(me.handle, inv.id);
      return { declined: inv.room };
    },

    /** Join a chat from an invite link, as this account. */
    async joinAs(base, key, code) {
      return enter(base, await load(key), code);
    },

    /** The member token for one of this account's chats. `room` may be its code or name; not needed when there is only one. */
    async chatToken(key, room) {
      return pick(await load(key), room);
    },

    async leaveAs(key, room) {
      const me = await load(key);
      const r = pick(me, room);
      await app.as(r.token, (s, rm, member) => s.leave(rm, member)).catch((e) => { if (!gone(e)) throw e; });
      await doc(me.handle, (a) => a && { save: { ...a, rooms: a.rooms.filter((x) => x.code !== r.code) } });
      return { left: r.name };
    },

    /**
     * Everything waiting for this account: invites, and unread messages in its chats.
     * With `wait`, holds until there is a new invite or a mention in any chat.
     */
    async check(base, key, { wait = 0, signal } = {}) {
      const handle = handleFromKey(key);
      wait = Math.min(Math.max(Number(wait) || 0, 0), 50);

      const read = async () => {
        const me = await load(key);
        const lost = [];
        const chats = (await Promise.all(me.rooms.map(async (r) => {
          try {
            const inbox = await app.inbox(r.token, { only: wait ? 'mentions' : 'all' });
            return inbox.messages.length ? { code: r.code, name: r.name, ...inbox } : null;
          } catch (e) {
            if (!gone(e)) throw e;
            lost.push(r.code);
            return null;
          }
        }))).filter(Boolean);
        const fresh = me.invites.some((i) => !i.shown);
        if (lost.length || fresh || Date.now() - me.seen > DAY) {
          await doc(handle, (a) => a && {
            save: { ...a, seen: Date.now(), rooms: a.rooms.filter((r) => !lost.includes(r.code)), invites: a.invites.map((i) => ({ ...i, shown: true })) },
          });
        }
        return {
          you: card(me),
          invites: me.invites.map(inviteView),
          chats,
          quiet: me.rooms.filter((r) => !lost.includes(r.code) && !chats.some((c) => c.code === r.code)).map((r) => r.name),
          news: fresh || chats.length > 0,
        };
      };

      if (!wait) return read();
      await load(key); // a bad key fails before we start waiting
      const deadline = Date.now() + wait * 1000;
      const w = await watch(handle);
      try {
        let seen = null;
        let result = null;
        for (;;) {
          const tick = w.tick();
          const now = await w.stamp();
          if (now !== seen || !result) {
            seen = now;
            result = await read();
            if (result.news) return result;
          }
          if (Date.now() >= deadline || signal?.aborted) return result;
          await w.next(tick, deadline - Date.now(), signal);
        }
      } finally {
        w.stop();
      }
    },
  });

  function pick(me, room) {
    const names = me.rooms.map((r) => `"${r.name}" (${r.code})`).join(', ');
    if (room === undefined || room === null || room === '') {
      if (me.rooms.length === 1) return me.rooms[0];
      throw new GcError(400, 'which_chat', me.rooms.length ? `@${me.handle} is in ${me.rooms.length} chats, so say which one.` : `@${me.handle} is not in a chat yet.`,
        me.rooms.length ? `Pass "room": the name or code of one of ${names}.` : 'Start one (start_chat, or POST /api/agent/chats), or accept an invite.');
    }
    const want = String(room).trim();
    const hit = me.rooms.find((r) => r.code === want) ?? me.rooms.find((r) => slug(r.name) === slug(want));
    if (!hit) {
      throw new GcError(404, 'no_such_chat', `@${me.handle} is not in a chat called "${want}".`, names ? `Use one of ${names}.` : 'Start one, or accept an invite.');
    }
    return hit;
  }

  function findInvite(me, which) {
    const want = String(which ?? '').trim();
    const inv = me.invites.find((i) => i.id === want) ?? me.invites.find((i) => slug(i.room) === slug(want))
      ?? (!want && me.invites.length === 1 ? me.invites[0] : null);
    if (!inv) {
      throw new GcError(404, 'no_such_invite', want ? `No waiting invite matches "${want}".` : 'Say which invite.',
        me.invites.length ? `Waiting invites: ${me.invites.map((i) => `${i.id} ("${i.room}" from @${i.from})`).join(', ')}.` : 'There are no invites waiting. Check again later.');
    }
    return inv;
  }

  const drop = (handle, inviteId) => doc(handle, (a) => a && { save: { ...a, invites: a.invites.filter((i) => i.id !== inviteId) } });
}
