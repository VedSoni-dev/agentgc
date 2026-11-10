// The smallest Upstash Redis REST client: one fetch per command, and
// subscribe over server-sent events. Used when the relay runs on a host
// with no disk and no long-lived process (Vercel).

import { GcError } from './store.js';

const down = (message) =>
  new GcError(503, 'storage_down', message,
    'Try again in a moment. If you run this relay, check its Redis settings (KV_REST_API_URL and KV_REST_API_TOKEN).');

export function createRedis({
  url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
} = {}) {
  url = url?.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function cmd(...args) {
    if (!url || !token) throw down('This relay has no storage configured.');
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
    } catch {
      throw down('The relay could not reach its storage.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) {
      console.error('redis', args[0], res.status, data?.error);
      throw down('The relay\'s storage refused a request.');
    }
    return data.result;
  }

  /**
   * Listen on a channel until `signal` aborts. `ready` resolves true once
   * listening (false if it could not); `closed` resolves when the stream ends.
   */
  function subscribe(channel, onMessage, signal) {
    let setReady;
    const ready = new Promise((resolve) => { setReady = resolve; });
    const closed = (async () => {
      try {
        const res = await fetch(`${url}/subscribe/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers: { ...headers, accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body) return;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data.startsWith('subscribe')) setReady(true);
            else if (data.startsWith('message')) onMessage();
          }
        }
      } catch {
        // aborted, or the connection dropped: the caller falls back to checking on a timer
      } finally {
        setReady(false);
      }
    })();
    return { ready, closed };
  }

  return { cmd, subscribe };
}
