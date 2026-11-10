#!/usr/bin/env node
// A demo with no AI in it: three scripted "agents" with made-up calendars use
// the real relay over HTTP, so you can see the flow without any API key.
//
//   npm run demo            run the conversation, then keep the room open
//   npm run demo -- --once  run it and exit

import { createApp } from '../src/relay.js';
import { api } from '../src/client.js';
import { formatMessage } from '../src/format.js';

const once = process.argv.includes('--once');
const portArg = process.argv.indexOf('--port');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS = ['Friday', 'Saturday', 'Sunday'];

const relay = createApp();
const port = await relay.listen(portArg > -1 ? Number(process.argv[portArg + 1]) : once ? 0 : 4747);
const server = `http://localhost:${port}`;

const room = await api(server, '/api/rooms', { method: 'POST', body: { name: 'dinner this weekend' } });
const join = (body) => api(server, `/api/rooms/${room.code}/join`, { method: 'POST', body });
const say = (token, text) => api(server, '/api/messages', { method: 'POST', token, body: { text } });
const inbox = (token, only) => api(server, `/api/inbox?wait=50${only ? '&only=mentions' : ''}`, { token });

/** An agent that only ever answers free or busy for its human. */
async function responder(name, owner, calendar) {
  const { token } = await join({ name, owner, about: `${owner}'s availability (free or busy only)` });
  for (;;) {
    const { messages } = await inbox(token, true);
    const ask = messages.filter((m) => m.mentions.includes(name) && m.text.includes('?')).pop();
    if (!ask) continue;
    const days = DAYS.filter((d) => ask.text.toLowerCase().includes(d.toLowerCase()));
    await sleep(900);
    await say(token, `${owner}: ${(days.length ? days : DAYS.slice(0, 2)).map((d) => `${d} evening ${calendar[d]}`).join(', ')}.`);
  }
}

/** An agent that asks the others and reports the evening everyone has free. */
async function organizer(name, owner, calendar, others) {
  const { token } = await join({ name, owner, about: `Plans things for ${owner}` });
  for (;;) {
    const { messages } = await inbox(token, true);
    const ask = messages.filter((m) => m.kind === 'human' && m.mentions.includes(name)).pop();
    if (!ask) continue;
    await sleep(900);
    await say(token, `${others.map((o) => '@' + o).join(' ')} is your human free Friday or Saturday evening?`);
    const answers = new Map();
    while (answers.size < others.length) {
      for (const m of (await inbox(token, false)).messages) {
        if (others.includes(m.from)) answers.set(m.from, m.text);
      }
    }
    const works = DAYS.filter((d) => calendar[d] === 'free' && [...answers.values()].every((t) => t.includes(`${d} evening free`)));
    await sleep(900);
    await say(token, works.length
      ? `${works[0]} evening works for everyone. @${ask.from} should I propose 7pm?`
      : `No evening works for everyone. @${ask.from} want me to ask about next week?`);
  }
}

responder('sam-agent', 'Sam', { Friday: 'busy', Saturday: 'free', Sunday: 'free' });
responder('priya-agent', 'Priya', { Friday: 'free', Saturday: 'free', Sunday: 'busy' });
organizer('vedant-agent', 'Vedant', { Friday: 'free', Saturday: 'free', Sunday: 'free' }, ['sam-agent', 'priya-agent']);

const human = await join({ name: 'vedant', kind: 'human' });
relay.store.subscribe(relay.store.room(room.code), (event, data) => {
  if (event === 'message') console.log(formatMessage(data));
});

console.log(`Scripted demo (no AI model involved). Watch it in a browser: ${room.watch_url}\n`);
await sleep(once ? 300 : 4000);
await say(human.token, '@vedant-agent find an evening this weekend for dinner with Sam and Priya');

const done = () => relay.store.room(room.code).messages.some((m) => /works for everyone|No evening/.test(m.text));
while (!done()) await sleep(100);

if (once) {
  await relay.close();
  process.exit(0);
}
console.log(`\nThe room stays open. Join as yourself at ${room.watch_url} and ask again, e.g. "@sam is Sam free Sunday?". Ctrl-C to stop.`);
