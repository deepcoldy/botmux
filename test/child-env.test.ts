import { describe, it, expect } from 'vitest';
import { redactChildEnv } from '../src/utils/child-env.js';

describe('redactChildEnv()', () => {
  it('truly removes leaked keys — absent, not present-with-"undefined"', () => {
    const out = redactChildEnv({
      LARK_APP_ID: 'cli_bot',
      LARK_APP_SECRET: 'secret',
      CLAUDECODE: '1',
      KEEP: 'v',
      PATH: '/usr/bin',
    });
    // The bug this guards: `{ ...env, LARK_APP_ID: undefined }` leaves the key
    // PRESENT (`'LARK_APP_ID' in obj === true`), and node-pty then stringifies
    // it to "undefined". Deleting makes the key absent. Assert ABSENCE, not
    // just falsy value.
    expect('LARK_APP_ID' in out).toBe(false);
    expect('LARK_APP_SECRET' in out).toBe(false);
    expect('CLAUDECODE' in out).toBe(false);
    // Unrelated vars pass through untouched.
    expect(out.KEEP).toBe('v');
    expect(out.PATH).toBe('/usr/bin');
  });

  it('does not mutate the input env', () => {
    const base = { LARK_APP_ID: 'a', LARK_APP_SECRET: 's', CLAUDECODE: '1' };
    redactChildEnv(base);
    expect(base.LARK_APP_ID).toBe('a');
    expect(base.LARK_APP_SECRET).toBe('s');
    expect(base.CLAUDECODE).toBe('1');
  });

  it('removes GitHub tokens from child env', () => {
    const out = redactChildEnv({
      GITHUB_TOKEN: 'ghp_secret',
      GH_TOKEN: 'ghs_secret',
      KEEP: 'v',
    });
    expect('GITHUB_TOKEN' in out).toBe(false);
    expect('GH_TOKEN' in out).toBe(false);
    expect(out.KEEP).toBe('v');
  });

  it('real node-pty child does NOT inherit a redacted var (not the string "undefined")', async () => {
    // End-to-end guard for the actual leak vector Codex found: a spawned child
    // must see the redacted var as genuinely UNSET. `${VAR+x}` expands to empty
    // only when VAR is unset, distinguishing "unset" from "set to the string
    // 'undefined'". Run against the real bundled node-pty + /bin/sh.
    const pty = await import('node-pty');
    const prev = process.env.LARK_APP_ID;
    process.env.LARK_APP_ID = 'cli_parent_must_not_leak';
    try {
      const env = redactChildEnv(process.env) as { [k: string]: string };
      const script =
        'if [ -z "${LARK_APP_ID+x}" ]; then echo "R=UNSET"; else echo "R=SET[$LARK_APP_ID]"; fi';
      const out: string = await new Promise((resolve) => {
        const p = pty.spawn('/bin/sh', ['-c', script], {
          name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env,
        });
        let buf = '';
        p.onData((d) => { buf += d; });
        p.onExit(() => resolve(buf));
      });
      expect(out).toContain('R=UNSET');
      expect(out).not.toContain('undefined');
    } finally {
      if (prev === undefined) delete process.env.LARK_APP_ID;
      else process.env.LARK_APP_ID = prev;
    }
  });
});
