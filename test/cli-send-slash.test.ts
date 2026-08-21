import { describe, expect, it } from 'vitest';

import { validateSlashSend } from '../src/cli/send-dispatch.js';

describe('validateSlashSend', () => {
  it('accepts a bare single-line slash command', () => {
    expect(validateSlashSend('/clear')).toEqual({ ok: true, command: '/clear' });
  });

  it('accepts a slash command with arguments', () => {
    expect(validateSlashSend('/model opus')).toEqual({ ok: true, command: '/model opus' });
  });

  it('trims surrounding whitespace (heredoc trailing newline is the common case)', () => {
    expect(validateSlashSend('  /compact \n')).toEqual({ ok: true, command: '/compact' });
    expect(validateSlashSend('/clear\n')).toEqual({ ok: true, command: '/clear' });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(validateSlashSend('')).toMatchObject({ ok: false });
    expect(validateSlashSend('   ')).toMatchObject({ ok: false });
    expect(validateSlashSend('\n\n')).toMatchObject({ ok: false });
  });

  it('rejects content that does not start with a slash', () => {
    const r = validateSlashSend('clear');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('/');
  });

  it('rejects a leading @mention before the slash (would break command detection)', () => {
    // A user pasting "@Bot /clear" as the --slash body is a mistake: the daemon
    // strips leading mentions by NAME from its own mentions[] list, not from raw
    // text a peer typed, so an inline "@Bot" here would not be stripped. Reject.
    expect(validateSlashSend('@Bot /clear')).toMatchObject({ ok: false });
  });

  it('rejects multi-line content (the exact regression --slash exists to prevent)', () => {
    // A multi-line body is what the card-footer path produced, demoting the
    // command to an ordinary prompt on the receiver. Fail loud instead.
    expect(validateSlashSend('/clear\nextra line')).toMatchObject({ ok: false });
    expect(validateSlashSend('/clear\r\nextra')).toMatchObject({ ok: false });
  });
});
