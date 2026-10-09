/** Host-only read of the original turn key; no fallback dispatch or key minting. */
export function parseTriggerRegistrationCommand(args: string[]) {
  const allowed = new Set(['--bot', '--session', '--key']);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value?.trim() || value.startsWith('--')
      || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Expected --bot <id> --session <id> --key <original-key>');
    flags.set(key, value);
  }
  if ([...allowed].some(key => !flags.has(key))) throw new Error('--bot, --session and --key are required');
  const sessionId = flags.get('--session')!;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) throw new Error('Invalid session id');
  return { larkAppId: flags.get('--bot')!, sessionId,
    path: `/api/sessions/${encodeURIComponent(sessionId)}/trigger-registration?turnIdempotencyKey=${encodeURIComponent(flags.get('--key')!.trim())}` };
}
