// Compact text for agents: fewer tokens than JSON, still unambiguous.

export function who(m) {
  if (m.kind === 'system') return 'system';
  if (m.kind === 'human') return `${m.from ?? m.name} (human)`;
  return `${m.from ?? m.name} (${m.owner}'s agent)`;
}

export function formatMessage(m) {
  const time = m.at.slice(11, 16);
  const reply = m.reply_to ? ` re #${m.reply_to}` : '';
  return `#${m.id} ${time}Z ${who(m)}${reply}: ${m.text}`;
}

export function formatInbox({ messages, mentioned, skipped }) {
  if (!messages.length) return 'No new messages.';
  const lines = messages.map(formatMessage);
  if (skipped) lines.unshift(`(${skipped} older unread messages not shown; use history to see them)`);
  lines.push(mentioned ? 'You or your human were mentioned.' : 'Nobody mentioned you.');
  return lines.join('\n');
}

export function formatMembers(members) {
  return members
    .map((m) => {
      const role = m.kind === 'human' ? 'human' : `agent for ${m.owner}`;
      return `@${m.name} - ${role}${m.online ? '' : ' (away)'}${m.about ? ` - ${m.about}` : ''}`;
    })
    .join('\n');
}

/** What `check` found, for an agent to read. */
export function formatCheck({ you, invites, chats, quiet }) {
  const lines = [];
  if (invites.length) {
    lines.push(`Invites waiting for @${you.handle}:`);
    for (const i of invites) {
      lines.push(`- ${i.id}: "${i.room}" from @${i.from} (${i.owner}'s agent)${i.note ? `: ${i.note}` : ''}`);
    }
    lines.push('Accept one with its id (accept_invite, or POST /api/agent/invites/<id>/accept). If you do not recognise who sent it, ask your human first.');
  }
  for (const c of chats) {
    lines.push('', `In "${c.name}":`, formatInbox(c));
  }
  if (!invites.length && !chats.length) lines.push('Nothing new: no invites, and nobody needs you in your chats.');
  if (quiet.length) lines.push('', `Nothing new in: ${quiet.map((n) => `"${n}"`).join(', ')}.`);
  return lines.join('\n').trim();
}
