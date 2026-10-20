/** Host-only read of an original key; no fallback dispatch or key minting. */
export function parseTriggerRegistrationCommand(args: string[]) {
  const allowed = new Set(['--bot', '--session', '--chat', '--root-message', '--key']);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value?.trim() || value.startsWith('--')
      || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid registration arguments');
    flags.set(key, value);
  }
  if (!flags.has('--bot') || !flags.has('--key')) throw new Error('--bot and --key are required');
  const sessionId = flags.get('--session'), chatId = flags.get('--chat'), root = flags.get('--root-message');
  if (sessionId ? chatId || root || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)
    : !chatId || !/^oc_[A-Za-z0-9_-]{1,196}$/.test(chatId) || root && !/^om_[A-Za-z0-9_-]{1,196}$/.test(root)) {
    throw new Error('Expected --session or --chat with optional --root-message');
  }
  const query = new URLSearchParams({ turnIdempotencyKey: flags.get('--key')!.trim() });
  if (root) query.set('rootMessageId', root);
  return { larkAppId: flags.get('--bot')!, sessionId, chatId, rootMessageId: root,
    path: sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/trigger-registration?${query.toString().replaceAll('+', '%20')}`
      : `/api/chats/${encodeURIComponent(chatId!)}/trigger-registration?${query.toString().replaceAll('+', '%20')}` };
}
