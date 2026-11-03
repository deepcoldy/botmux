import { describe, expect, it } from 'vitest';

import { RunnerControlWriter } from '../src/adapters/cli/runner-control-channel.js';
import { createRunnerTerminal, parseRunnerFlags } from '../src/runner-common.js';
import { errorMessage } from '../src/utils/error-message.js';

interface Args {
  sessionId: string;
  botName?: string;
  locale?: string;
  turnTimeoutMs: number;
}
const MAX = 3_600_000;

// Verbatim shape of the hand-rolled loops the runners used before the helper.
function oldParse(argv: string[]): Args {
  const out: Args = { sessionId: '', turnTimeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--locale' && val !== undefined) { out.locale = val; i++; }
    else if (key === '--turn-timeout-ms' && val !== undefined) {
      const n = Number(val);
      if (Number.isInteger(n) && n > 0 && n <= MAX) out.turnTimeoutMs = n;
      i++;
    }
  }
  return out;
}
function newParse(argv: string[]): Args {
  const out: Args = { sessionId: '', turnTimeoutMs: 600_000 };
  return parseRunnerFlags(argv, out, {
    '--session-id': 'sessionId',
    '--bot-name': 'botName',
    '--locale': 'locale',
    '--turn-timeout-ms': (target, val) => {
      const n = Number(val);
      if (Number.isInteger(n) && n > 0 && n <= MAX) target.turnTimeoutMs = n;
    },
  });
}

describe('parseRunnerFlags', () => {
  it('matches the hand-rolled loop on every argv shape (exhaustive over a token alphabet)', () => {
    const alphabet = ['--session-id', '--bot-name', '--locale', '--turn-timeout-ms', '--unknown', 'x', '5', '0', '-1', '1.5', '99999999999', '', '--session-id'];
    let checked = 0;
    const walk = (prefix: string[], depth: number): void => {
      expect(newParse(prefix)).toEqual(oldParse(prefix));
      checked++;
      if (depth === 0) return;
      for (const token of alphabet) walk([...prefix, token], depth - 1);
    };
    walk([], 4);
    expect(checked).toBeGreaterThan(30_000);
  });

  it('consumes a matched pair, skips unknown tokens one at a time, last occurrence wins', () => {
    expect(newParse(['--junk', '--session-id', 'a', '--session-id', 'b', '--bot-name', 'n'])).toMatchObject({ sessionId: 'b', botName: 'n' });
  });

  it('a recognised flag with no value after it is ignored', () => {
    expect(newParse(['--session-id'])).toMatchObject({ sessionId: '' });
    expect(newParse(['--turn-timeout-ms', '10', '--locale'])).toEqual({ sessionId: '', turnTimeoutMs: 10 });
  });

  it('a recognised flag takes the next token as its value even if it looks like a flag', () => {
    // '--locale' is swallowed as the value, so the trailing 'zh' is a stray token.
    expect(newParse(['--session-id', '--locale', 'zh'])).toEqual({ sessionId: '--locale', turnTimeoutMs: 600_000 });
  });

  it('an invalid turn timeout is consumed but ignored (keeps the default)', () => {
    expect(newParse(['--turn-timeout-ms', 'abc', '--locale', 'en'])).toMatchObject({ turnTimeoutMs: 600_000, locale: 'en' });
  });

  it('never resolves Object.prototype names as flags', () => {
    const out = newParse(['constructor', 'x', '__proto__', 'y', 'toString', 'z', 'hasOwnProperty', 'w']);
    expect(out).toEqual({ sessionId: '', turnTimeoutMs: 600_000 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('createRunnerTerminal', () => {
  it('writes the same frames the per-runner helpers did', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writer = new RunnerControlWriter(c => { stdout.push(c); return true as never; }, c => { stderr.push(c); return true as never; });
    const { emitMarker, writeLine, prompt } = createRunnerTerminal(writer);
    writeLine('hi');
    writeLine();
    prompt();
    emitMarker('mir-ready', { ok: true });
    const expected: string[] = [];
    const ref = new RunnerControlWriter(c => { expected.push(c); return true as never; });
    ref.line('hi'); ref.line(''); ref.display('› '); ref.marker('mir-ready', { ok: true });
    expect(stdout).toEqual(expected);
    expect(stderr).toEqual([]);
  });

  it('rejects an invalid marker kind the way the writer does', () => {
    const { emitMarker } = createRunnerTerminal(new RunnerControlWriter(() => true as never, () => true as never));
    expect(() => emitMarker('Bad Kind', {})).toThrow('invalid runner control kind');
  });
});

describe('errorMessage', () => {
  it('is the Error message, else String(value)', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('t'))).toBe('t');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage({ toString: () => 'obj' })).toBe('obj');
  });
});
