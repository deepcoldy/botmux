import { parseInputCaptureConditions } from '../core/plugins/input-capture/conditions.js';

export function parseInputCaptureCommand(args: string[]) {
  const operation = args[0];
  if (!['register', 'inspect', 'revoke', 'revoke-set'].includes(operation)) throw new Error('Expected register, inspect, revoke or revoke-set');
  const allowed = new Set(['--bot', '--session', ...(operation === 'register'
    ? ['--plugin', '--request', '--ref', '--input-anchor', '--input-thread-id', '--capture-attachments'] : operation === 'revoke-set'
      ? ['--bindings'] : ['--binding', ...(operation === 'revoke' ? ['--revision'] : ['--after', '--through'])])]);
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith('--')
      || value.length > (key === '--bindings' ? 8192 : 1000) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid input-capture arguments');
    flags.set(key, value);
  }
  if ([...allowed].some(key => !['--input-anchor', '--input-thread-id', '--capture-attachments', '--after', '--through'].includes(key) && !flags.has(key))) throw new Error('All input-capture identity flags are required');
  if (flags.has('--through') && !flags.has('--after')) throw new Error('Input page requires --after');
  for (const key of ['--after', '--through']) {
    if (flags.has(key) && (!/^(0|[1-9][0-9]*)$/.test(flags.get(key)!)
      || !Number.isSafeInteger(Number(flags.get(key))))) throw new Error('Invalid input page sequence');
  }
  if (flags.has('--through') && Number(flags.get('--through')) < Number(flags.get('--after'))) throw new Error('Invalid input page range');
  if (flags.has('--input-thread-id') && !/^omt_[A-Za-z0-9_-]+$/.test(flags.get('--input-thread-id')!)) throw new Error('Invalid input thread id');
  if (flags.has('--capture-attachments') && !['true', 'false'].includes(flags.get('--capture-attachments')!)) throw new Error('Invalid attachment subscription');
  if (operation === 'revoke' && (!/^[1-9][0-9]*$/.test(flags.get('--revision')!)
    || !Number.isSafeInteger(Number(flags.get('--revision'))))) throw new Error('Invalid binding revision');
  const larkAppId = flags.get('--bot')!;
  const conditions = operation === 'revoke-set' ? parseInputCaptureConditions(JSON.parse(flags.get('--bindings')!)) : undefined;
  return { larkAppId, path: `/api/sessions/${encodeURIComponent(flags.get('--session')!)}/input-capture`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      larkAppId, operation, ...(operation === 'register' ? {
        pluginId: flags.get('--plugin'), requestId: flags.get('--request'), providerRef: flags.get('--ref'),
        ...(flags.has('--input-anchor') ? { inputAnchor: flags.get('--input-anchor') } : {}),
        ...(flags.has('--input-thread-id') ? { inputThreadId: flags.get('--input-thread-id') } : {}),
        ...(flags.has('--capture-attachments') ? { captureAttachments: flags.get('--capture-attachments') === 'true' } : {}),
      } : operation === 'revoke-set' ? { bindings: conditions }
        : { bindingId: flags.get('--binding'), ...(operation === 'revoke' ? { expectedRevision: Number(flags.get('--revision')) } : {
          ...(flags.has('--after') ? { after: Number(flags.get('--after')) } : {}),
          ...(flags.has('--through') ? { through: Number(flags.get('--through')) } : {}),
        }) }),
    }) } };
}
