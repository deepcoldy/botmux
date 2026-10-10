/** Explicit host-only observation; caller env is not a source of actor identity. */
export function parseInteractionContextCommand(args: string[]) {
  const allowed = new Set(['--bot', '--session', '--actor']);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith('--')
      || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Expected --bot <id> --session <id> [--actor <open_id>]');
    flags.set(key, value);
  }
  if (!flags.has('--bot') || !flags.has('--session')) throw new Error('--bot and --session are required');
  const larkAppId = flags.get('--bot')!;
  return { larkAppId, path: `/api/sessions/${encodeURIComponent(flags.get('--session')!)}/interaction-context`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ larkAppId, ...(flags.has('--actor') ? { actorOpenId: flags.get('--actor')! } : {}) }) } };
}
