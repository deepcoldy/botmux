import { expect, it } from 'vitest';
import { parseAskFactCommand } from '../ask-fact.js';
it('selects one original bot, session, request and Ask without implicit lookup', () => {
  const command=parseAskFactCommand(['--bot','cli_fixture','--session','source-session','--request','question request','--ask','original-ask']);
  const url=new URL(command.path,'http://fixture');
  expect(url.pathname).toBe('/api/asks/fact');expect(url.searchParams.get('requestId')).toBe('question request');
  for(const args of [[],['--bot','cli_fixture'],['--bot','cli_fixture','--bot','other'],['--latest','true']])
    expect(()=>parseAskFactCommand(args)).toThrow();
});
