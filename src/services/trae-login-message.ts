/** Callback control input must not enter persistent/replayable message bodies. */
export function isTraeLoginCallbackEvent(data: unknown): boolean {
  type Message = { content?: unknown; body?: { content?: unknown }; mentions?: Array<{ key?: string }> };
  const event = data as { message?: Message; event?: { message?: Message } } | undefined;
  const message = event?.message ?? event?.event?.message;
  let content = message?.content ?? message?.body?.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* plain text */ }
  }
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if ('tag' in value && value.tag === 'at') return;
      for (const [key, nested] of Object.entries(value)) if (key !== 'tag') visit(nested);
    }
  };
  visit(content);
  let text = strings.join(' ').trimStart();
  // Only host-provided mention keys can precede an actual command. Discussion
  // containing an example later in the body retains ordinary durable routing.
  const keys = (message?.mentions ?? []).flatMap(m => [m.key,
    'name' in m && typeof m.name === 'string' ? '@' + m.name : undefined]).filter((k): k is string => !!k)
    .sort((a, b) => b.length - a.length);
  for (;;) {
    const key = keys.find(k => text.startsWith(k) && /^\s/.test(text.slice(k.length)));
    if (!key) break;
    text = text.slice(key.length).trimStart();
  }
  return /^\/dashboard\s+trae-login\s+complete\b/i.test(text);
}
export function redactTraeLoginCallbackEvent<T>(data: T): T {
  if (!isTraeLoginCallbackEvent(data)) return data;
  const copy = JSON.parse(JSON.stringify(data));
  for (const message of [copy.message, copy.event?.message]) if (message) {
    message.content = JSON.stringify({ text: '/dashboard trae-login complete [redacted]' });
    if (message.body && typeof message.body === 'object') message.body.content = message.content;
    message.message_type = 'text';
  }
  return copy;
}
