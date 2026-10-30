import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_PROBE_EXPECTED,
  SANDBOX_PROBE_TOKEN,
  planSandboxBotConfig,
  sandboxCanaryDir,
  sandboxProbeCommand,
  sandboxSecretPaths,
} from './helpers/mock-llm-server/sandbox-probe.js';

const TAG = 'e2e-sbx-1793300000000';
const prompt = (text: string) => [{ role: 'user', content: [{ type: 'text', text }] }];

describe('sandbox probe of the mock LLM', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('answers only a probe in the latest turn', () => {
    expect(sandboxProbeCommand(prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用 botmux send`))).toContain(`"ACK-${TAG} SBX `);
    expect(sandboxProbeCommand(prompt(`${TAG} 请立刻调用 botmux send`))).toBeNull();
    const older = [...prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用`), { role: 'assistant', content: 'ok' }, ...prompt('next')];
    expect(sandboxProbeCommand(older)).toBeNull();
  });

  it('reports the opposite of every expected check when run outside a sandbox', () => {
    // The checks must be able to fail: on the host each one sees what the
    // sandbox must hide.
    root = mkdtempSync(path.join(tmpdir(), 'botmux-sbx-probe-'));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const bin = path.join(root, 'bin');
    for (const dir of [home, work, bin]) mkdirSync(dir, { recursive: true });
    mkdirSync(sandboxCanaryDir(home), { recursive: true });
    writeFileSync(path.join(sandboxCanaryDir(home), 'secret.txt'), 'canary');
    writeFileSync(path.join(work, 'test-bots.json'), '[]');
    writeFileSync(path.join(work, 'storageState.json'), '{}');
    const recorded = path.join(root, 'sent.txt');
    writeFileSync(path.join(bin, 'botmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\n`);
    chmodSync(path.join(bin, 'botmux'), 0o755);

    const env = { ...process.env, HOME: home, BOTS_CONFIG: 'test-bots.json' };
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    let command: string | null;
    try {
      process.env.HOME = home;
      process.env.BOTS_CONFIG = 'test-bots.json';
      process.chdir(work);
      expect(sandboxSecretPaths().bots).toBe(path.join(work, 'test-bots.json'));
      command = sandboxProbeCommand(prompt(`${TAG} ${SANDBOX_PROBE_TOKEN} 请立刻调用 botmux send`));
    } finally {
      process.chdir(savedCwd);
      process.env.HOME = savedHome;
      delete process.env.BOTS_CONFIG;
    }
    const run = spawnSync('bash', ['--noprofile', '--norc', '-c', command!], {
      cwd: work,
      env: { ...env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const line = readFileSync(recorded, 'utf8').split('\n')[2];
    expect(line).toBe(`ACK-${TAG} SBX pid1=host home=READ bots=READ state=READ outside=WROTE workdir=OK`);
    expect(existsSync(path.join(sandboxCanaryDir(home), `w-${TAG}`))).toBe(true);
    expect(existsSync(path.join(work, `sbx-${TAG}`))).toBe(true);
    // Same checks, same order as the line a sandbox must produce.
    expect(SANDBOX_PROBE_EXPECTED.split(' ').map((c) => c.split('=')[0])).toEqual(
      line.split(' ').slice(2).map((c) => c.split('=')[0]),
    );
  });
});

describe('planSandboxBotConfig for run-e2e.ts', () => {
  const cwd = '/repo';
  const secretPaths = { bots: '/repo/test-bots.json', state: '/repo/storageState.json' };
  const depsWith = (existing: ReadonlySet<string>, tempDir = '/tmp/botmux-sbx-work-FRESH') => {
    let tempMints = 0;
    return {
      tempMints: () => tempMints,
      deps: {
        cwd,
        joinPath: path.join,
        secretPaths,
        existsSync: (file: string) => existing.has(file),
        makeTempWorkDir: () => {
          tempMints += 1;
          return tempDir;
        },
      },
    };
  };

  it('replaces the working directory of every sandbox mode with a fresh temp dir, even one that exists', () => {
    // Regression for "config names an existing workingDir such as '.'": the old
    // gate kept it, leaving the sandboxed CLI read-write in the checkout while
    // the lane passed.
    for (const sandbox of [true, 'oncall', 'scratch']) {
      const { deps, tempMints } = depsWith(new Set(['.']));
      const plan = planSandboxBotConfig({ sandbox, workingDir: '.' }, deps);
      expect(plan.workingDir).toBe('/tmp/botmux-sbx-work-FRESH');
      expect(tempMints()).toBe(1);
    }
  });

  it('replaces an explicit workingDirs list, which takes precedence over workingDir', () => {
    // bot-registry resolves the session dir as workingDirs[0] ?? workingDir
    // and sessions iterate every entry, so leaving the list keeps the sandbox
    // read-write in the named checkout dir despite the replaced workingDir.
    const { deps } = depsWith(new Set(['/repo', '.']));
    const plan = planSandboxBotConfig(
      { sandbox: true, workingDir: '.', workingDirs: ['/repo', '/repo/second'] },
      deps,
    );
    expect(plan.workingDir).toBe('/tmp/botmux-sbx-work-FRESH');
    expect(plan.workingDirs).toEqual(['/tmp/botmux-sbx-work-FRESH']);
  });

  it('redirects the layer-4 pins defaultWorkingDir and defaultOncall.workingDir only when present', () => {
    // effectiveDefaultWorkingDir (defaultWorkingDir, or defaultOncall.workingDir
    // when enabled) pins every new session — including p2p chats — with
    // precedence over workingDir, so an untouched value keeps the session in
    // the named checkout dir.
    const { deps } = depsWith(new Set(['/repo', '.']));
    const plan = planSandboxBotConfig(
      {
        sandbox: true,
        workingDir: '.',
        defaultWorkingDir: '/repo',
        defaultOncall: { enabled: true, workingDir: '/repo/oncall', since: 1 },
      },
      deps,
    );
    expect(plan.defaultWorkingDir).toBe('/tmp/botmux-sbx-work-FRESH');
    expect(plan.defaultOncallWorkingDir).toBe('/tmp/botmux-sbx-work-FRESH');
    // Absent fields are not invented.
    const bare = planSandboxBotConfig({ sandbox: true, workingDir: '.' }, depsWith(new Set(['.'])).deps);
    expect(bare.defaultWorkingDir).toBeUndefined();
    expect(bare.defaultOncallWorkingDir).toBeUndefined();
    // Non-sandboxed configs never touch these pins.
    const off = planSandboxBotConfig(
      { sandbox: false, defaultWorkingDir: '/repo', defaultOncall: { enabled: true, workingDir: '/repo/o' } },
      depsWith(new Set()).deps,
    );
    expect(off.defaultWorkingDir).toBeUndefined();
    expect(off.defaultOncallWorkingDir).toBeUndefined();
  });

  it('denies the existing secrets for sandboxed bots and keeps pre-configured deny entries', () => {
    // .env is absent on this host and must not be added.
    const existing = new Set(['/repo/test-bots.json', '/repo/storageState.json']);
    const { deps } = depsWith(existing);
    const plan = planSandboxBotConfig(
      { sandbox: true, sandboxPaths: { deny: ['/repo/already-denied'], readOnly: ['/repo/ro'] } },
      deps,
    );
    expect(plan.sandboxPaths?.deny.sort()).toEqual(
      ['/repo/already-denied', '/repo/storageState.json', '/repo/test-bots.json'].sort(),
    );
  });

  it('leaves non-sandboxed bots alone except for the missing-workingDir default', () => {
    for (const sandbox of [false, undefined, null, 'off']) {
      // Existing working dir: untouched, no temp mint, no sandboxPaths.
      const present = depsWith(new Set(['/work']));
      const planPresent = planSandboxBotConfig({ sandbox, workingDir: '/work' }, present.deps);
      expect(planPresent.workingDir).toBeUndefined();
      expect(planPresent.workingDirs).toBeUndefined();
      expect(planPresent.sandboxPaths).toBeUndefined();
      expect(present.tempMints()).toBe(0);
      // Missing working dir: defaults to '.', still no sandboxPaths.
      const missing = depsWith(new Set());
      const planMissing = planSandboxBotConfig({ sandbox }, missing.deps);
      expect(planMissing.workingDir).toBe('.');
      expect(planMissing.workingDirs).toBeUndefined();
      expect(planMissing.sandboxPaths).toBeUndefined();
      expect(missing.tempMints()).toBe(0);
    }
  });

  it('fails closed on an unknown sandbox mode', () => {
    const { deps } = depsWith(new Set());
    expect(() => planSandboxBotConfig({ sandbox: 'oncall ' }, deps)).toThrow(/invalid sandbox mode/);
  });
});
