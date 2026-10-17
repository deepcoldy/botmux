export function parseInteractionActorCommand(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--bot', '--chat', '--open', '--union'].includes(name) || flags.has(name)
      || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('--'))
      throw new Error('Invalid interaction-actor arguments');
    flags.set(name, value);
  }
  if (!flags.has('--bot') || !flags.has('--chat') || flags.has('--open') === flags.has('--union'))
    throw new Error('Expected --bot APP --chat CHAT and exactly one of --open OPEN_ID / --union UNION_ID');
  const larkAppId = flags.get('--bot')!;
  return { larkAppId, path: '/api/interactions/actor', init: {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      larkAppId, chatId: flags.get('--chat'), principal: flags.has('--union')
        ? { kind: 'union', unionId: flags.get('--union') }
        : { kind: 'app_open', larkAppId, openId: flags.get('--open') },
    }),
  } };
}
