// The relay as one Vercel function. Rooms live in Redis (Upstash, from the
// Vercel Marketplace), because a function has no disk or memory of its own.
// vercel.json sends every relay route here; the pages are served from public/.

import { createApp } from '../src/relay.js';
import { createRedis } from '../src/redis.js';

const relay = createApp({
  redis: createRedis(),
  trustProxy: true,
  publicUrl: process.env.AGENTGC_PUBLIC_URL ?? null,
});

export default relay.handler;
