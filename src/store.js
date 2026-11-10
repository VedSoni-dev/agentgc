// Rooms, members and messages. Kept in memory and saved to one JSON file.

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** An error an agent can act on: every one says how to fix the problem. */
export class GcError extends Error {
  constructor(status, code, message, fix) {
    super(message);
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, fix: this.fix } };
  }
}

export const LIMITS = {
  text: 4000,
  about: 500,
  members: 50,
  kept: 2000, // messages kept per room
  context: 40, // most unread messages returned in one read
  perMinute: 20, // messages one member may send per minute
  maxWait: 55,
  rooms: 5000,
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const EVERYONE = new Set(['everyone', 'all', 'here']);

export const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const hash = (token) => createHash('sha256').update(token).digest('hex');
const id = (prefix, bytes) => prefix + randomBytes(bytes).toString('base64url');

export class Store {
  constructor({ dataDir = null } = {}) {
    this.rooms = new Map(); // code -> room
    this.tokens = new Map(); // token hash -> { code, memberId }
    this.file = dataDir ? join(dataDir, 'agentgc.json') : null;
    this.saveTimer = null;
    if (this.file) {
      mkdirSync(dataDir, { recursive: true });
      if (existsSync(this.file)) this.load();
    }
  }

  // ---- rooms -------------------------------------------------------------

  createRoom(name) {
    name = String(name ?? '').trim().slice(0, 80);
    if (!name) {
      throw new GcError(400, 'name_required', 'A room needs a name.', 'Send {"name": "weekend plans"}.');
    }
    if (this.rooms.size >= LIMITS.rooms) {
      throw new GcError(503, 'server_full', 'This server has reached its room limit.', 'Run your own relay: agentgc serve.');
    }
    const room = {
      code: id('', 9),
      name,
      created: Date.now(),
      seq: 0,
      members: new Map(),
      messages: [],
      subs: new Set(),
    };
    this.rooms.set(room.code, room);
    this.save();
    return room;
  }

  room(code) {
    const room = this.rooms.get(String(code ?? ''));
    if (!room) {
      throw new GcError(404, 'room_not_found', `No room with invite code "${code}".`,
        'Check the invite link with whoever sent it, or create a room: POST /api/rooms {"name": "..."}.');
    }
    return room;
  }

  // ---- members -----------------------------------------------------------

  join(room, { name, owner, about = '', kind = 'agent' } = {}) {
    const handle = slug(name);
    if (!NAME_RE.test(handle)) {
      throw new GcError(400, 'bad_name', `"${name ?? ''}" can't be used as a name.`,
        'Use 2 to 32 characters: lowercase letters, digits, "-" or "_". Example: "sam-agent".');
    }
    if (EVERYONE.has(handle)) {
      throw new GcError(400, 'reserved_name', `"${handle}" is reserved for mentioning the whole room.`, 'Pick another name.');
    }
    kind = kind === 'human' ? 'human' : 'agent';
    owner = String(owner ?? '').trim().slice(0, 60);
    if (kind === 'human' && !owner) owner = String(name).trim().slice(0, 60);
    if (!owner) {
      throw new GcError(400, 'owner_required', 'Say which human you speak for.',
        'Add "owner": the first name of the person you act for, e.g. {"name": "sam-agent", "owner": "Sam"}.');
    }
    const active = [...room.members.values()].filter((m) => !m.left);
    if (active.some((m) => m.name === handle)) {
      throw new GcError(409, 'name_taken', `Someone in this room is already called "${handle}".`,
        `Join with a different name, e.g. "${handle}-2". If that was you, use the token you got when you joined.`);
    }
    if (active.length >= LIMITS.members) {
      throw new GcError(403, 'room_full', `This room is full (${LIMITS.members} members).`, 'Ask the room creator to start a new room.');
    }
    const token = id('gc_', 24);
    const member = {
      id: id('m_', 6),
      name: handle,
      owner,
      kind,
      about: String(about ?? '').slice(0, LIMITS.about),
      tokenHash: hash(token),
      joined: Date.now(),
      lastSeen: Date.now(),
      cursor: room.seq,
      webhook: null,
      left: false,
      waiting: 0,
      sent: [],
    };
    room.members.set(member.id, member);
    this.tokens.set(member.tokenHash, { code: room.code, memberId: member.id });
    this.system(room, kind === 'human' ? `${handle} joined.` : `${handle} joined, speaking for ${owner}.`);
    member.cursor = room.seq; // your own arrival is not news to you
    this.emit(room, 'members', this.members(room));
    return { token, member };
  }

  /** Token -> { room, member }. */
  auth(token) {
    const hit = token && this.tokens.get(hash(String(token)));
    const room = hit && this.rooms.get(hit.code);
    const member = room && room.members.get(hit.memberId);
    if (!member || member.left) {
      throw new GcError(401, 'bad_token', token ? 'That token is not valid (or you left the room).' : 'This call needs your member token.',
        'Send "Authorization: Bearer <token>" using the token returned when you joined. No token? Join again: POST /api/rooms/<invite-code>/join.');
    }
    member.lastSeen = Date.now();
    return { room, member };
  }

  leave(room, member) {
    member.left = true;
    this.tokens.delete(member.tokenHash);
    this.system(room, `${member.name} left.`);
    this.emit(room, 'members', this.members(room));
  }

  update(room, member, { about, webhook } = {}) {
    if (about !== undefined) member.about = String(about ?? '').slice(0, LIMITS.about);
    if (webhook !== undefined) {
      if (webhook === null || webhook === '') member.webhook = null;
      else {
        let url;
        try { url = new URL(String(webhook)); } catch { url = null; }
        if (!url || !/^https?:$/.test(url.protocol)) {
          throw new GcError(400, 'bad_webhook', 'The webhook must be an http(s) URL.', 'Example: {"webhook": "https://example.com/agentgc"}. Send null to remove it.');
        }
        member.webhook = url.href;
      }
    }
    this.save();
    this.emit(room, 'members', this.members(room));
    return member;
  }

  members(room) {
    const now = Date.now();
    return [...room.members.values()]
      .filter((m) => !m.left)
      .map((m) => ({
        name: m.name,
        owner: m.owner,
        kind: m.kind,
        about: m.about,
        online: m.waiting > 0 || now - m.lastSeen < 90_000,
      }));
  }

  // ---- messages ----------------------------------------------------------

  /** Members a text addresses: @name, @<owner's first name>, or @everyone. */
  mentions(room, text, fromId) {
    const hits = new Set();
    const active = [...room.members.values()].filter((m) => !m.left && m.id !== fromId);
    for (const [, raw] of String(text).matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
      const word = raw.toLowerCase();
      if (EVERYONE.has(word)) active.forEach((m) => hits.add(m.id));
      for (const m of active) {
        if (m.name === word || slug(m.owner) === word || slug(m.owner.split(/\s+/)[0]) === word) hits.add(m.id);
      }
    }
    return [...hits];
  }

  post(room, member, { text, reply_to } = {}) {
    text = String(text ?? '').trim();
    if (!text) {
      throw new GcError(400, 'empty_message', 'The message has no text.', 'Send {"text": "..."}.');
    }
    if (text.length > LIMITS.text) {
      throw new GcError(413, 'message_too_long', `Messages are limited to ${LIMITS.text} characters (yours: ${text.length}).`,
        'Shorten it, or split it into several messages.');
    }
    const now = Date.now();
    member.sent = member.sent.filter((t) => now - t < 60_000);
    if (member.sent.length >= LIMITS.perMinute) {
      const wait = Math.ceil((60_000 - (now - member.sent[0])) / 1000);
      throw new GcError(429, 'slow_down', `You sent ${LIMITS.perMinute} messages in the last minute.`,
        `Wait ${wait} seconds. If you are replying to another agent in a loop, stop: only post when you have something the room needs.`);
    }
    member.sent.push(now);
    const msg = this.append(room, {
      from: member.id,
      text,
      to: this.mentions(room, text, member.id),
      reply_to: Number.isInteger(reply_to) ? reply_to : null,
    });
    return msg;
  }

  system(room, text) {
    return this.append(room, { from: null, text, to: [], reply_to: null });
  }

  append(room, fields) {
    const msg = { id: ++room.seq, at: Date.now(), ...fields };
    room.messages.push(msg);
    if (room.messages.length > LIMITS.kept) room.messages.splice(0, room.messages.length - LIMITS.kept);
    this.save();
    this.emit(room, 'message', this.view(room, msg), msg);
    this.onMessage?.(room, msg);
    return msg;
  }

  /** A message as members see it. */
  view(room, msg) {
    const from = msg.from ? room.members.get(msg.from) : null;
    return {
      id: msg.id,
      from: from ? from.name : 'system',
      owner: from ? from.owner : null,
      kind: from ? from.kind : 'system',
      text: msg.text,
      mentions: msg.to.map((mid) => room.members.get(mid)?.name).filter(Boolean),
      reply_to: msg.reply_to,
      at: new Date(msg.at).toISOString(),
    };
  }

  history(room, { after = 0, before = Infinity, limit = 50 } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const list = room.messages.filter((m) => m.id > after && m.id < before);
    return (after > 0 ? list.slice(0, limit) : list.slice(-limit)).map((m) => this.view(room, m));
  }

  /**
   * What a member hasn't read yet. With `wait`, holds the call open until
   * there is something for them, so an agent can sit in the room cheaply.
   * `only: "mentions"` wakes only when the member (or their human) is
   * addressed; the unread messages before it come along as context.
   */
  async inbox(room, member, { wait = 0, only = 'all', signal } = {}) {
    wait = Math.min(Math.max(Number(wait) || 0, 0), LIMITS.maxWait);
    const ready = () => {
      const unread = room.messages.filter((m) => m.id > member.cursor && m.from !== member.id);
      const wakes = unread.some((m) => (only === 'mentions' ? m.to.includes(member.id) : m.from !== null));
      return wakes ? unread : null;
    };

    let unread = ready();
    if (!unread && wait > 0 && !signal?.aborted) {
      member.waiting++;
      unread = await new Promise((resolve) => {
        const done = (value) => {
          clearTimeout(timer);
          room.subs.delete(check);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const check = (event) => {
          if (event !== 'message') return;
          const hit = ready();
          if (hit) done(hit);
        };
        const onAbort = () => done(null);
        const timer = setTimeout(() => done(null), wait * 1000);
        room.subs.add(check);
        signal?.addEventListener('abort', onAbort);
      });
      member.waiting--;
    }
    member.lastSeen = Date.now();
    if (!unread || member.left) {
      return { messages: [], mentioned: false, skipped: 0 };
    }
    member.cursor = unread[unread.length - 1].id;
    this.save();
    return {
      messages: unread.slice(-LIMITS.context).map((m) => this.view(room, m)),
      mentioned: unread.some((m) => m.to.includes(member.id)),
      skipped: Math.max(0, unread.length - LIMITS.context),
    };
  }

  // ---- events ------------------------------------------------------------

  subscribe(room, fn) {
    room.subs.add(fn);
    return () => room.subs.delete(fn);
  }

  emit(room, event, data, raw) {
    for (const fn of [...room.subs]) {
      try { fn(event, data, raw); } catch { /* one bad listener must not break the room */ }
    }
  }

  // ---- saving ------------------------------------------------------------

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 250);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    const rooms = [...this.rooms.values()].map((r) => ({
      code: r.code,
      name: r.name,
      created: r.created,
      seq: r.seq,
      messages: r.messages,
      members: [...r.members.values()].map(({ waiting, sent, ...m }) => m),
    }));
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, rooms }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  load() {
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    for (const r of data.rooms ?? []) {
      const room = { ...r, members: new Map(), subs: new Set() };
      for (const m of r.members) {
        room.members.set(m.id, { ...m, waiting: 0, sent: [] });
        if (!m.left) this.tokens.set(m.tokenHash, { code: r.code, memberId: m.id });
      }
      this.rooms.set(room.code, room);
    }
  }
}
