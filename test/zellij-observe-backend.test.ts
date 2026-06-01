import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every `zellij` invocation the observe backend makes.
const calls: string[][] = [];
vi.mock('node:child_process', () => ({
  execFileSync: (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return '';
  },
}));

import { ZellijObserveBackend } from '../src/adapters/backend/zellij-observe-backend.js';

const S = 'usersess';
const P = 'terminal_2';
const actionArgs = (cmd: string) =>
  calls.find(c => c[3] === 'action' && c[4] === cmd)?.slice(4);

describe('ZellijObserveBackend input encoding', () => {
  let be: ZellijObserveBackend;
  beforeEach(() => {
    calls.length = 0;
    be = new ZellijObserveBackend(S, P, { cliPid: 999 });
  });

  it('sendText → targeted write-chars on the pane', () => {
    be.sendText('hello');
    expect(actionArgs('write-chars')).toEqual(['write-chars', '--pane-id', P, '--', 'hello']);
  });

  it('sendSpecialKeys(Enter) → action write with the CR byte (13)', () => {
    be.sendSpecialKeys('Enter');
    expect(actionArgs('write')).toEqual(['write', '--pane-id', P, '13']);
  });

  it('sendSpecialKeys(C-c) → action write with ETX byte (3)', () => {
    be.sendSpecialKeys('C-c');
    expect(actionArgs('write')).toEqual(['write', '--pane-id', P, '3']);
  });

  it('pasteText wraps text in bracketed-paste markers', () => {
    be.pasteText('x');
    // captured call = ['zellij','--session',S,'action','write','--pane-id',P,...bytes]
    // \e[200~  = 27 91 50 48 48 126 ; \e[201~ = 27 91 50 48 49 126
    const writes = calls.filter(c => c[4] === 'write').map(c => c.slice(7));
    const chars = calls.filter(c => c[4] === 'write-chars').map(c => c.slice(7));
    expect(writes[0]).toEqual(['27', '91', '50', '48', '48', '126']); // open bracket
    expect(chars[0]).toEqual(['--', 'x']);
    expect(writes[1]).toEqual(['27', '91', '50', '48', '49', '126']); // close bracket
  });

  it('getChildPid returns the adopted cli pid', () => {
    expect(be.getChildPid()).toBe(999);
  });

  it('resize is a no-op (never issues a zellij command — non-invasive)', () => {
    be.resize(200, 50);
    expect(calls).toHaveLength(0);
  });
});
