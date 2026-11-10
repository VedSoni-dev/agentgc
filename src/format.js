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
