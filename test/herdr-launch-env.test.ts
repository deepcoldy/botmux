/**
 * Herdr launches the CLI from an INTERACTIVE shell (managed facade) or through
 * `herdr agent start` (legacy), so the user's rcfile runs BEFORE our removals
 * unless they sit on the final exec. The ordinary `unsetEnv` must therefore
 * ride along with the protected list on BOTH paths — otherwise a fresh dsh-tui
 * spawn can have its resume markers re-injected by an rcfile and resume another
 * conversation.
 *
 * These tests execute the real command/launcher scripts and inspect the final
 * process environ; they never assert on source text.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHerdrFinalCommand, createPaneAgentLauncher } from '../src/adapters/backend/herdr-backend.js';

const MARKERS = [
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

/** A fake CLI that prints its argv + environ, standing in for the real one. */
function fakeCli(): string {
  const dir = tempDir('herdr-fake-cli-');
  const path = join(dir, 'fake-cli');
  writeFileSync(path, [
    '#!/bin/sh',
    'printf "ARGV=%s\\n" "$*"',
    'env',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

/** The env the interactive shell would hand an exec'd command: the markers are
 *  present exactly as an rcfile export would leave them. */
function shellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...Object.fromEntries(MARKERS.map(key => [key, 'stale'])),
    ...extra,
  };
}

function assertClean(out: string): void {
  for (const marker of MARKERS) expect(out).not.toContain(`${marker}=`);
}

describe('buildHerdrFinalCommand (legacy `herdr agent start -- …`)', () => {
  it('strips inherited markers on the FINAL exec, after the shell that exported them', () => {
    const cli = fakeCli();
    const argv = buildHerdrFinalCommand(cli, ['--flag', 'value'], { unsetEnv: [...MARKERS] });
    const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: shellEnv() });
    assertClean(out);
    // The CLI still receives its argv untouched.
    expect(out).toContain('ARGV=--flag value');
  });

  it('keeps the protected semantics: reserved names only go through the trusted list', () => {
    const cli = fakeCli();
    const ordinaryOnly = buildHerdrFinalCommand(cli, [], { unsetEnv: ['BOTMUX_PROTECTED_SECRET_FD'] });
    // Ordinary removals refuse reserved names (session-env lock) — same rule as
    // the tmux/zellij backends.
    expect(execFileSync(ordinaryOnly[0]!, ordinaryOnly.slice(1), {
      encoding: 'utf8',
      env: shellEnv({ BOTMUX_PROTECTED_SECRET_FD: 'sensitive' }),
    })).toContain('BOTMUX_PROTECTED_SECRET_FD=sensitive');

    const both = buildHerdrFinalCommand(cli, [], {
      unsetEnv: [...MARKERS],
      protectedUnsetEnv: ['BOTMUX_PROTECTED_SECRET_FD'],
    });
    const out = execFileSync(both[0]!, both.slice(1), {
      encoding: 'utf8',
      env: shellEnv({ BOTMUX_PROTECTED_SECRET_FD: 'sensitive' }),
    });
    assertClean(out);
    expect(out).not.toContain('BOTMUX_PROTECTED_SECRET_FD=');
  });
});

describe('createPaneAgentLauncher (managed-agent facade)', () => {
  it('the generated launcher strips markers the interactive shell exported before running it', () => {
    const cli = fakeCli();
    const launcher = createPaneAgentLauncher('fake-cli', cli, ['--boot'], '/usr/bin:/bin', {
      unsetEnv: [...MARKERS],
    });
    // Herdr runs the launcher by absolute path from a pane whose shell already
    // re-added the markers (server env + rcfile).
    const out = execFileSync(launcher.path, [], { encoding: 'utf8', env: shellEnv() });
    assertClean(out);
    expect(out).toContain('ARGV=--boot');
    // The launcher removes itself before exec (its dir may already be gone).
    expect(existsSync(launcher.path)).toBe(false);
  });

  it('also honors protected removals alongside the ordinary ones', () => {
    const cli = fakeCli();
    const launcher = createPaneAgentLauncher('fake-cli', cli, [], '/usr/bin:/bin', {
      unsetEnv: [...MARKERS],
      protectedUnsetEnv: ['BOTMUX_PROTECTED_SECRET_FD'],
    });
    const out = execFileSync(launcher.path, [], {
      encoding: 'utf8',
      env: shellEnv({ BOTMUX_PROTECTED_SECRET_FD: 'secret' }),
    });
    assertClean(out);
    expect(out).not.toContain('BOTMUX_PROTECTED_SECRET_FD=');
  });

  it('quotes an argv containing spaces/quotes so the CLI still gets it verbatim', () => {
    const cli = fakeCli();
    const launcher = createPaneAgentLauncher('fake-cli', cli, ['a b', `x'y`], '/usr/bin:/bin', {
      unsetEnv: [...MARKERS],
    });
    const out = execFileSync(launcher.path, [], { encoding: 'utf8', env: shellEnv() });
    expect(out).toContain(`ARGV=a b x'y`);
  });
});
