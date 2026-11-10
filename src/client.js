// What the command line uses to talk to a relay, and where it keeps tokens.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export class CliError extends Error {
  constructor(message, fix, code = 'error') {
    super(message);
    this.fix = fix;
    this.code = code;
  }
}

const home = () => process.env.AGENTGC_HOME || join(homedir(), '.agentgc');
const file = () => join(home(), 'config.json');

export function loadConfig() {
  if (!existsSync(file())) return { current: null, rooms: {} };
  return { current: null, rooms: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
}

export function saveConfig(config) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** "http://host/join/CODE" or "CODE" -> { server, code }. */
export function parseInvite(invite, server) {
  const text = String(invite ?? '').trim();
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    const code = url.pathname.split('/').filter(Boolean).pop();
    return { server: url.origin, code };
  }
  if (!text) throw new CliError('No invite given.', 'Pass the invite link: agentgc join http://host/join/<code> --name <handle> --owner <first name>');
  return { server: (server || 'http://localhost:4747').replace(/\/+$/, ''), code: text };
}

export async function api(server, path, { method = 'GET', token, body } = {}) {
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CliError(`Could not reach the relay at ${server}.`, 'Check the address. To run one locally: agentgc serve', 'unreachable');
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = data.error ?? {};
    throw new CliError(e.message ?? `The relay answered ${res.status}.`, e.fix ?? 'Try again.', e.code ?? `http_${res.status}`);
  }
  return data;
}
