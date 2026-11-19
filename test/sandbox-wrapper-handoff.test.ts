import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWrappedLaunch } from '../src/setup/cli-selection.js';
import { installAidenCodexShim } from '../src/services/aiden-codex-shim.js';
import { sessionIdentityBinDir } from '../src/core/cli-identity.js';
import {
  buildsSandboxWrapperLaunch,
  canonicalHandoffPath,
  sandboxHandoffResolver,
  sandboxWrapperLaunchFrom,
  wrapperLaunchWiring,
} from '../src/core/sandbox-wrapper-launch.js';

// The sandboxed wrapper launch must (a) exist whenever the wrapper rewrote
// the launch, even if the binary stayed the same, and (b) carry only
// sandbox-resolvable handoff paths: the file sandbox's fresh root binds
// canonical paths, so a symlinked $HOME / install dir does not exist there
// under its lexical name. Built with the same helpers the worker uses.

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** /home/u → /data00/home/u: lexical paths exist, the real files live on the canonical tree. */
function symlinkedHost() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-handoff-')));
  roots.push(root);
  mkdirSync(join(root, 'data00/home/u/.local/bin'), { recursive: true });
  mkdirSync(join(root, 'data00/home/u/.botmux/data'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  symlinkSync(join(root, 'data00/home/u'), join(root, 'home/u'));
  for (const b of ['aiden', 'codex']) {
    const f = join(root, `data00/home/u/.local/bin/${b}`);
    writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755);
  }
  return { lexHome: join(root, 'home/u') };
}

const isCanonical = (p: string) => { try { return realpathSync(p) === p; } catch { return false; } };

describe('sandboxed wrapper launch', () => {
  it('P1: an args-only wrapper (prefix starts with the CLI name) still yields a sandboxed launch', () => {
    const resolvedBin = '/usr/local/bin/codex';
    const base = ['--resume', 'abc'];
    const launch = buildWrappedLaunch('codex --profile withhooks', base, b => (b === 'codex' ? resolvedBin : b));
    expect(launch.bin).toBe(resolvedBin);
    expect(launch.args).toEqual(['--profile', 'withhooks', '--resume', 'abc']);
    const sandboxed = sandboxWrapperLaunchFrom({
      applied: !!launch.bin, wrapperCli: 'codex --profile withhooks',
      bin: launch.bin, args: launch.args, cliBin: resolvedBin,
    });
    expect(sandboxed?.args).toEqual(['--profile', 'withhooks', '--resume', 'abc']);
    expect(sandboxWrapperLaunchFrom({ applied: false, wrapperCli: 'x', bin: resolvedBin, args: base, cliBin: resolvedBin }))
      .toBeUndefined();
  });

  it('P1-b/P1-c: shim bin, args[0], REAL_BIN and SHELL_CONFIG_FILE are all canonical', () => {
    const { lexHome } = symlinkedHost();
    // The worker builds the shim dir from the sandbox's canonical identity data dir.
    const shimDir = installAidenCodexShim(join(sessionIdentityBinDir(realpathSync(join(lexHome, '.botmux/data')), 'sess'), 'aiden-codex'));
    const cfg = join(shimDir, 'shell-configs');
    writeFileSync(cfg, 'shell_environment_policy.inherit=all\n');
    const launch = buildWrappedLaunch('aiden x codex',
      ['-c', 'shell_environment_policy.set.BOTMUX_SESSION_ID="s"', 'exec', 'hi'],
      sandboxHandoffResolver(b => join(lexHome, '.local/bin', b)),   // PATH lookup is lexical
      { aidenCodexRealBin: canonicalHandoffPath(join(lexHome, '.local/bin/codex')), aidenCodexShimDir: shimDir,
        requireAidenCodexShim: true, writeAidenShellConfigs: () => cfg });
    expect(launch.bin, 'shim branch entered').toBe(`${shimDir}/launch`);
    expect(isCanonical(launch.bin), 'bin').toBe(true);
    expect(isCanonical(launch.env!.BOTMUX_AIDEN_CODEX_SHELL_CONFIG_FILE!), 'CFG_FILE').toBe(true);
    expect(isCanonical(launch.args[0]!), `args[0]: ${launch.args[0]}`).toBe(true);
    expect(isCanonical(launch.env!.BOTMUX_AIDEN_CODEX_REAL_BIN!), `REAL_BIN: ${launch.env!.BOTMUX_AIDEN_CODEX_REAL_BIN}`).toBe(true);
    // Only handoff paths change: CLI arguments are untouched.
    expect(launch.args.slice(1)).toEqual(['x', 'codex', 'exec', 'hi']);
  });

  it('P2: never builds the launch for a warm reattach, and only on local pty/tmux', () => {
    const base = { wrapperConfigured: true, sandboxRequested: true, backendType: 'tmux', reattach: false };
    expect(buildsSandboxWrapperLaunch(base)).toBe(true);
    expect(buildsSandboxWrapperLaunch({ ...base, backendType: 'pty' })).toBe(true);
    expect(buildsSandboxWrapperLaunch({ ...base, reattach: true })).toBe(false);
    expect(buildsSandboxWrapperLaunch({ ...base, backendType: 'herdr' })).toBe(false);
    expect(buildsSandboxWrapperLaunch({ ...base, sandboxRequested: false })).toBe(false);
    expect(buildsSandboxWrapperLaunch({ ...base, wrapperConfigured: false })).toBe(false);
  });

  it('worker wiring: canonical shim dir, resolver and REAL_BIN inside the sandbox; lexical, untouched outside', () => {
    const { lexHome } = symlinkedHost();
    const lexData = join(lexHome, '.botmux/data');
    const input = {
      sessionDataDir: lexData,
      identityDataDir: realpathSync(lexData),
      resolveBin: (b: string) => join(lexHome, '.local/bin', b),
      realCliBin: join(lexHome, '.local/bin/codex'),
    };
    const inside = wrapperLaunchWiring({ ...input, insideSandbox: true });
    expect(isCanonical(inside.shimDataDir!), 'shimDataDir').toBe(true);
    expect(isCanonical(inside.binResolver('aiden')), 'resolver').toBe(true);
    expect(isCanonical(inside.aidenCodexRealBin), 'REAL_BIN').toBe(true);
    const outside = wrapperLaunchWiring({ ...input, insideSandbox: false });
    expect(outside.shimDataDir).toBe(lexData);
    expect(outside.binResolver('aiden')).toBe(join(lexHome, '.local/bin/aiden'));
    expect(outside.aidenCodexRealBin).toBe(join(lexHome, '.local/bin/codex'));
  });

  it('keeps bare names and unresolvable paths as given', () => {
    expect(canonicalHandoffPath('codex')).toBe('codex');
    expect(canonicalHandoffPath('/definitely/not/here')).toBe('/definitely/not/here');
  });
});
