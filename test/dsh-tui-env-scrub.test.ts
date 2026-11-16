/**
 * dsh-tui resume-marker hygiene + the child-spawn env plan that the worker
 * hands to `backend.spawn()`.
 *
 * The launcher turns `DSH_TUI_RESUME_SESSION` / `_BACKEND` / `_RETRY` into
 * "resume this native session". Botmux only sets `--resume <id>` for a real
 * resume, so a spawn that ends up FRESH must not carry those markers: one left
 * in the daemon env, in the bot's `env`, or in a persistent backend's shared
 * server environment / rcfile would silently resume a conversation this
 * session never asked for.
 *
 * Everything here is behaviour-level: the plan's three products (the exact
 * values the worker passes on) and what the two backends really do with them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_TUI_RESUME_ENV_KEYS,
  dshTuiResumeEnvKeysToDrop,
  dshTuiResumeEnvUnset,
  dshTuiResumeScope,
} from '../src/core/dsh-tui-env.js';
import { planChildSpawnEnv } from '../src/core/child-spawn-env.js';
import { buildBotmuxEnvAssignments, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { ptyChildEnv } from '../src/adapters/backend/pty-backend.js';

/** The three markers the launcher owns (bin/dsh-tui `setResumeEnv`). */
const RESUME_MARKERS = [
  'DSH_TUI_RESUME_SESSION',
  'DSH_TUI_RESUME_BACKEND',
  'DSH_TUI_RESUME_RETRY',
] as const;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function inheritedBase(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    DSH_HOME: '/home/u/.dsh',
    DSH_TUI_RESUME_SESSION: 'other-topic-native-session',
    DSH_TUI_RESUME_BACKEND: 'tmux',
    DSH_TUI_RESUME_RETRY: '1',
  };
}

function botEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    DSH_TUI_RESUME_SESSION: 'bot-config-session',
    DSH_TUI_RESUME_BACKEND: 'zellij',
    DSH_TUI_RESUME_RETRY: '1',
  };
}

const FRESH = { fresh: true, cliId: 'dsh-tui' } as const;

describe("dshTuiResumeScope — the worker's resolved spawn decisions", () => {
  it('fresh spawn (no resume intent)', () => {
    expect(dshTuiResumeScope({ resume: false, cliId: 'dsh-tui', willReattachPersistent: false }))
      .toEqual({ fresh: true, cliId: 'dsh-tui', willReattachPersistent: false });
  });

  it('resume intent keeps the resume payload semantics', () => {
    const scope = dshTuiResumeScope({ resume: true, cliId: 'dsh-tui', willReattachPersistent: false });
    expect(scope).toEqual({ fresh: false, cliId: 'dsh-tui', willReattachPersistent: false });
    expect(dshTuiResumeEnvKeysToDrop(scope)).toEqual(['DSH_TUI_RESUME_RETRY']);
  });

  it('a PREDICTED reattach is carried through: the backends may still spawn for real', () => {
    // zellij's frozen reattach downgrades to a real fresh spawn when the pane is
    // provably absent — after the worker computed `resume: true`. Dropping this
    // flag at the call site would hand the launcher its resume markers on a
    // launch that actually starts a new session.
    const scope = dshTuiResumeScope({ resume: true, cliId: 'dsh-tui', willReattachPersistent: true });
    expect(scope.willReattachPersistent).toBe(true);
    expect(dshTuiResumeEnvKeysToDrop(scope)).toEqual([...RESUME_MARKERS]);
  });

  it('other CLIs keep an empty drop list regardless of the flags', () => {
    expect(dshTuiResumeEnvKeysToDrop(dshTuiResumeScope({
      resume: false, cliId: 'dsh', willReattachPersistent: true,
    }))).toEqual([]);
  });
});

describe('dshTuiResumeEnvKeysToDrop', () => {
  it('drops every marker for a fresh dsh-tui spawn', () => {
    expect(dshTuiResumeEnvKeysToDrop(FRESH)).toEqual([...RESUME_MARKERS]);
  });

  it('drops only the retry flag when the spawn really resumes', () => {
    // SESSION/BACKEND are the resume payload; RETRY is only honored from the
    // launcher's own safe-mode retry, so an INHERITED `1` must never turn an
    // explicit bad id into a silent downgrade instead of dsh's boot fatal.
    expect(dshTuiResumeEnvKeysToDrop({ fresh: false, cliId: 'dsh-tui' }))
      .toEqual(['DSH_TUI_RESUME_RETRY']);
  });

  it('treats a predicted persistent reattach as fresh (frozen reattach can become a real spawn)', () => {
    // zellij's frozen reattach downgrades to a REAL fresh spawn when the
    // session is provably missing — after effectiveResume was computed.
    expect(dshTuiResumeEnvKeysToDrop({ fresh: false, cliId: 'dsh-tui', willReattachPersistent: true }))
      .toEqual([...RESUME_MARKERS]);
  });

  it.each(['dsh', 'claude-code', 'codex', undefined])(
    'never touches another CLI (%s)',
    (cliId) => {
      expect(dshTuiResumeEnvKeysToDrop({ fresh: true, cliId })).toEqual([]);
    },
  );
});

describe('planChildSpawnEnv — the three products handed to backend.spawn()', () => {
  it('a fresh dsh-tui spawn: both env layers cleaned, pane removals listed', () => {
    const base = inheritedBase();
    const bot = botEnv();
    const plan = planChildSpawnEnv({ baseEnv: base, botEnv: bot, envUnset: ['FOO'], scope: FRESH });

    for (const marker of RESUME_MARKERS) {
      expect(plan.childEnv[marker]).toBeUndefined();
      expect(plan.injectEnv?.[marker]).toBeUndefined();
    }
    // Nothing else is collateral damage.
    expect(plan.childEnv.PATH).toBe('/usr/bin:/bin');
    expect(plan.childEnv.DSH_HOME).toBe('/home/u/.dsh');
    expect(plan.injectEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://example.invalid' });
    expect(plan.unsetEnv).toEqual(['FOO', ...RESUME_MARKERS]);
    // Pure: the caller's objects are untouched.
    expect(base.DSH_TUI_RESUME_SESSION).toBe('other-topic-native-session');
    expect(bot.DSH_TUI_RESUME_RETRY).toBe('1');
  });

  it('a resume keeps the payload but drops the retry flag from all three products', () => {
    const plan = planChildSpawnEnv({
      baseEnv: inheritedBase(),
      botEnv: botEnv(),
      envUnset: undefined,
      scope: { fresh: false, cliId: 'dsh-tui' },
    });
    expect(plan.childEnv.DSH_TUI_RESUME_SESSION).toBe('other-topic-native-session');
    expect(plan.injectEnv?.DSH_TUI_RESUME_BACKEND).toBe('zellij');
    expect(plan.childEnv.DSH_TUI_RESUME_RETRY).toBeUndefined();
    expect(plan.injectEnv?.DSH_TUI_RESUME_RETRY).toBeUndefined();
    expect(plan.unsetEnv).toEqual(['DSH_TUI_RESUME_RETRY']);
  });

  it('another CLI is untouched, and an empty bot env stays "nothing to inject"', () => {
    const plan = planChildSpawnEnv({
      baseEnv: inheritedBase(),
      botEnv: {},
      envUnset: undefined,
      scope: { fresh: true, cliId: 'claude-code' },
    });
    expect(plan.childEnv.DSH_TUI_RESUME_SESSION).toBe('other-topic-native-session');
    expect(plan.injectEnv).toBeUndefined();
    expect(plan.unsetEnv).toBeUndefined();
  });

  it('a well-known-marker-only bot env does not become an empty injectEnv', () => {
    const plan = planChildSpawnEnv({
      baseEnv: { PATH: '/bin' },
      botEnv: {
        DSH_TUI_RESUME_SESSION: 'x',
        DSH_TUI_RESUME_BACKEND: 'y',
        DSH_TUI_RESUME_RETRY: '1',
      },
      scope: FRESH,
    });
    expect(plan.injectEnv).toBeUndefined();
  });
});

describe('dshTuiResumeEnvUnset', () => {
  it('propagates the key set into the pane removal list', () => {
    expect(dshTuiResumeEnvUnset(FRESH, undefined)).toEqual([...RESUME_MARKERS]);
    expect(dshTuiResumeEnvUnset(FRESH, ['FOO'])).toEqual(['FOO', ...RESUME_MARKERS]);
  });

  it('dedupes a marker the session env already removes', () => {
    expect(dshTuiResumeEnvUnset(FRESH, ['DSH_TUI_RESUME_BACKEND']))
      .toEqual(['DSH_TUI_RESUME_BACKEND', 'DSH_TUI_RESUME_SESSION', 'DSH_TUI_RESUME_RETRY']);
  });

  it('leaves the caller list untouched otherwise', () => {
    expect(dshTuiResumeEnvUnset({ fresh: false, cliId: 'claude-code' }, ['FOO'])).toEqual(['FOO']);
    expect(dshTuiResumeEnvUnset({ fresh: false, cliId: 'claude-code' }, undefined)).toBeUndefined();
  });
});

/**
 * Both spawn shapes must receive the removal. That is a property of the plan
 * PLUS the backends' consumption, so it is asserted against the real backend
 * env builders (and, for tmux, the real wrapper script executing /usr/bin/env).
 */
describe('spawn paths consume the plan', () => {
  it('pty backend: the merged child env carries no marker (inject layer overlaid last)', () => {
    const plan = planChildSpawnEnv({ baseEnv: inheritedBase(), botEnv: botEnv(), scope: FRESH });
    const env = ptyChildEnv({
      env: plan.childEnv as Record<string, string>,
      injectEnv: plan.injectEnv,
      unsetEnv: plan.unsetEnv,
    });
    for (const marker of RESUME_MARKERS) expect(env[marker]).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
  });

  it('tmux backend: `env -u` on the pane final exec, even when the shell already has the marker', () => {
    // The pane's login shell re-reads the shared server env + rcfile AFTER the
    // worker's env object is gone: this removal list is the only channel that
    // reaches the CLI there.
    const argv = buildBotmuxEnvAssignments({ PATH: '/usr/bin:/bin' }, undefined, dshTuiResumeEnvUnset(FRESH, undefined));
    expect(argv).toEqual(RESUME_MARKERS.flatMap(key => ['-u', key]));
  });

  it.skipIf(process.platform === 'win32')('tmux backend: the pane wrapper really strips an rcfile-set marker', () => {
    const cwd = tempDir('dsh-tui-pane-');
    const script = shellWrapperScript(join(cwd, 'bin'), 'sh');
    const argv = [
      cwd,
      ...buildBotmuxEnvAssignments({}, undefined, dshTuiResumeEnvUnset(FRESH, undefined)),
      '/usr/bin/env',
    ];
    // The parent process plays the role of the shell that already exported the
    // markers (server global env / rcfile).
    const out = execFileSync('/bin/sh', ['-c', script, '_', ...argv], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...Object.fromEntries(RESUME_MARKERS.map(k => [k, 'stale'])) },
    });
    for (const marker of RESUME_MARKERS) expect(out).not.toContain(`${marker}=`);
    expect(out).toContain('PATH=');
  });

  it('the exported key tuple is exactly the three launcher markers', () => {
    // External contract: these names are read by the dsh-tui launcher.
    expect([...DSH_TUI_RESUME_ENV_KEYS].sort()).toEqual([...RESUME_MARKERS].sort());
  });
});
