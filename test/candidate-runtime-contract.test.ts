import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { sessionAgentConfig } from '../src/core/worker-pool.js';
import { launchCandidateRca } from '../src/services/candidate-rca-launch.js';
import * as candidateRuntimeModule from '../src/services/candidate-runtime-contract.js';
import {
  attestCandidateRuntimeSpawn,
  candidateBotmuxBuildIdentity,
  candidateBotmuxCommit,
  candidateRuntimeAttestationPath,
  hashCandidateRuntimeTree,
  prepareCandidateCocoHome,
  validateCandidateRuntimeContract,
  type CandidateRuntimeContract,
} from '../src/services/candidate-runtime-contract.js';

const COCO = realpathSync(join(process.env.HOME || '/home/zhubowen.cc', '.local', 'bin', 'coco'));
const exec = promisify(execFile);
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);

function botmuxIdentity(contract: CandidateRuntimeContract) {
  return {
    observeBotmuxIdentity: () => ({
      commit: contract.botmuxCommit,
      artifactSha256: contract.botmuxArtifactSha256,
    }),
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function testCocoCache(root: string): string {
  const cache = join(root, 'coco-cache');
  mkdirSync(cache, { recursive: true });
  return cache;
}

function fixture(): { root: string; contract: CandidateRuntimeContract } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-runtime-'));
  const repo = join(root, 'release-a-repo');
  const skills = join(root, 'release-a-skills');
  const capLock = join(root, 'capability-lock.json');
  const manifest = join(root, 'manifest.json');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(skills, 'release-only'), { recursive: true });
  writeFileSync(join(repo, 'release.txt'), 'release A\n');
  writeFileSync(join(skills, 'release-only', 'SKILL.md'), [
    '---',
    'name: release-only',
    'description: RELEASE_ONLY_SKILL_bfe24a',
    '---',
    '# release only',
    '',
  ].join('\n'));
  writeFileSync(capLock, '{"schemaVersion":1}\n');
  writeFileSync(manifest, '{"release":"A"}\n');
  const commit = 'a'.repeat(40);
  mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = ssh://example.invalid/release-a.git\n');
  return {
    root,
    contract: {
      schemaVersion: 1,
      incidentKey: 'argos:alarm-a',
      eventId: 'event-a',
      candidateDispatchId: 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      releaseId: 'release-a',
      releaseManifestSha256: sha256(manifest),
      runtimeBundleId: 'runtime-a',
      runtimeName: 'coco',
      searchRcaCommit: 'e'.repeat(40),
      botmuxCommit: candidateBotmuxCommit(),
      botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
      workspaceSnapshot: {
        realpath: realpathSync(repo),
        repository: 'ssh://example.invalid/release-a.git',
        commit,
      },
      capabilityLockSha256: sha256(capLock),
      skillsRoot: realpathSync(skills),
      skillsSha256: hashCandidateRuntimeTree(skills),
      executable: { realpath: COCO, sha256: sha256(COCO) },
      disabledFeatures: ['memories'],
      model: 'candidate-model-a',
      investigation: {
        title: 'alarm-a',
        symptom: 'service-a error rate elevated',
        preparedInput: { content: 'Investigate alarm-a.' },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'cli_candidate', chatId: 'oc_shadow' },
    },
  };
}

function buildArtifactFixture(ignoreRule = 'dist/\n'): {
  root: string;
  dist: string;
  manifestPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'botmux-build-artifact-'));
  const dist = join(root, 'dist');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  copyFileSync(
    join(import.meta.dirname, '..', 'scripts', 'audit-dist.mjs'),
    join(root, 'scripts', 'audit-dist.mjs'),
  );
  writeFileSync(join(root, '.gitignore'), ignoreRule);
  writeFileSync(join(root, 'package.json'), '{"name":"candidate-botmux-fixture"}\n');
  writeFileSync(join(dist, 'index-daemon.js'), 'export const daemon = true;\n');
  writeFileSync(join(dist, 'worker.js'), 'export const worker = true;\n');
  writeFileSync(join(dist, 'index-daemon.js.map'), '{"version":3}\n');
  writeFileSync(join(dist, 'assets', 'runtime.css'), '.candidate { color: green; }\n');
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'candidate@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Candidate Test']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'ssh://example.invalid/botmux.git']);
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'package.json', 'scripts/audit-dist.mjs']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'candidate fixture']);

  const files = [
    'assets/runtime.css',
    'index-daemon.js',
    'index-daemon.js.map',
    'worker.js',
  ].map(path => ({ path, sha256: sha256(join(dist, path)) }));
  const manifestPath = join(dist, 'botmux-build-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    botmuxCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    treeSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  })}\n`);
  return { root, dist, manifestPath };
}

describe('Candidate runtime contract', () => {
  it('generates the build manifest only from clean source and includes every dist file', () => {
    const { root, dist } = buildArtifactFixture();
    writeFileSync(join(root, 'package.json'), '{"name":"dirty-candidate-botmux"}\n');
    expect(() => execFileSync(process.execPath, [join(root, 'scripts', 'audit-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })).toThrow(/clean/i);

    writeFileSync(join(root, 'package.json'), '{"name":"candidate-botmux-fixture"}\n');
    execFileSync(process.execPath, [join(root, 'scripts', 'audit-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    const manifest = JSON.parse(readFileSync(join(dist, 'botmux-build-manifest.json'), 'utf8'));
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual([
      'assets/runtime.css',
      'index-daemon.js',
      'index-daemon.js.map',
      'worker.js',
    ]);
    expect(manifest.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects source drift between the clean check and manifest write', () => {
    const { root } = buildArtifactFixture();
    const fakeBin = mkdtempSync(join(tmpdir(), 'botmux-fake-git-'));
    const fakeGit = join(fakeBin, 'git');
    const marker = join(fakeBin, 'mutated');
    const packageJson = join(root, 'package.json');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(fakeGit, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
if (args.includes('status') && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, 'mutated\\n');
  writeFileSync(${JSON.stringify(packageJson)}, '{"name":"source-drift"}\\n');
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`);
    chmodSync(fakeGit, 0o755);

    expect(() => execFileSync(process.execPath, [join(root, 'scripts', 'audit-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })).toThrow(/clean|changed/i);
  });

  it('rejects added, deleted, or tampered files outside the complete dist tree summary', () => {
    const added = buildArtifactFixture();
    writeFileSync(join(added.dist, 'unmanifested-runtime.bin'), 'rogue runtime payload\n');
    expect(() => candidateBotmuxBuildIdentity(added.root)).toThrow(/artifact|dist tree/i);

    const nestedManifestName = buildArtifactFixture();
    writeFileSync(
      join(nestedManifestName.dist, 'assets', 'botmux-build-manifest.json'),
      '{"rogue":"runtime payload"}\n',
    );
    expect(() => candidateBotmuxBuildIdentity(nestedManifestName.root))
      .toThrow(/artifact|dist tree/i);

    const deleted = buildArtifactFixture();
    renameSync(join(deleted.dist, 'assets', 'runtime.css'), join(deleted.root, 'runtime.css.moved'));
    expect(() => candidateBotmuxBuildIdentity(deleted.root)).toThrow(/artifact|dist tree/i);

    const tampered = buildArtifactFixture();
    writeFileSync(join(tampered.dist, 'worker.js'), 'export const worker = "tampered";\n');
    expect(() => candidateBotmuxBuildIdentity(tampered.root)).toThrow(/artifact|dist tree/i);
  });

  it('rejects a dist root redirected outside the clean Candidate checkout', () => {
    const build = buildArtifactFixture('dist\n');
    const buildPayload = join(mkdtempSync(join(tmpdir(), 'botmux-external-dist-')), 'payload');
    renameSync(build.dist, buildPayload);
    symlinkSync(buildPayload, build.dist, 'dir');
    expect(() => execFileSync(process.execPath, [join(build.root, 'scripts', 'audit-dist.mjs')], {
      cwd: build.root,
      encoding: 'utf8',
    })).toThrow(/dist.*directory|symbolic link/i);

    const runtime = buildArtifactFixture();
    const runtimePayload = join(mkdtempSync(join(tmpdir(), 'botmux-external-dist-')), 'payload');
    renameSync(runtime.dist, runtimePayload);
    symlinkSync(runtimePayload, runtime.dist, 'dir');
    expect(() => candidateBotmuxBuildIdentity(runtime.root)).toThrow(/dist.*directory|symbolic link/i);
  });

  it('rejects artifact drift at the production launch boundary before Feishu send', async () => {
    const { root, contract } = fixture();
    writeFileSync(join(contract.workspaceSnapshot.realpath, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
    const sendTopic = vi.fn();
    const dispatchTurn = vi.fn();
    await expect(launchCandidateRca({
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
      topicMessage: 'Candidate runtime preflight',
      launchContext: contract,
    }, {
      dataDir: root,
      ...botmuxIdentity(contract),
      sendTopic,
      findTopicByDispatch: vi.fn(),
      findSessionByRoot: vi.fn(),
      dispatchTurn,
    })).rejects.toThrow(/workspace commit mismatch/);
    expect(sendTopic).not.toHaveBeenCalled();
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('rejects a release Skills symlink escape at the production launch boundary', async () => {
    const { root, contract } = fixture();
    const hostPoison = join(root, 'host-poison-skill.md');
    writeFileSync(hostPoison, 'HOST_POISON_SKILL\n');
    symlinkSync(hostPoison, join(contract.skillsRoot, 'host-poison'));
    contract.skillsSha256 = createHash('sha256').update(JSON.stringify([
      { path: 'host-poison', sha256: sha256(hostPoison) },
      {
        path: 'release-only/SKILL.md',
        sha256: sha256(join(contract.skillsRoot, 'release-only', 'SKILL.md')),
      },
    ])).digest('hex');
    const sendTopic = vi.fn();
    const dispatchTurn = vi.fn();

    await expect(launchCandidateRca({
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
      topicMessage: 'Candidate runtime Skills boundary',
      launchContext: contract,
    }, {
      dataDir: root,
      ...botmuxIdentity(contract),
      sendTopic,
      findTopicByDispatch: vi.fn(),
      findSessionByRoot: vi.fn(),
      dispatchTurn,
    })).rejects.toThrow(/symbolic link/i);
    expect(sendTopic).not.toHaveBeenCalled();
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('keeps Release A after the bot default changes to B and the Session is restored', () => {
    const { contract } = fixture();
    const restored = JSON.parse(JSON.stringify({
      session: {
        sessionId: 'session-a',
        chatId: 'oc_shadow',
        rootMessageId: 'om_root',
        title: 'Candidate A',
        status: 'active',
        createdAt: '2026-08-13T00:00:00.000Z',
        workingDir: contract.workspaceSnapshot.realpath,
        cliId: 'traex',
        cliPathOverride: contract.executable.realpath,
        model: contract.model,
        agentFrozen: true,
        candidateRuntimeContract: contract,
      },
      larkAppId: 'cli_candidate',
      chatId: 'oc_shadow',
    }));
    expect(sessionAgentConfig(restored, {
      cliId: 'claude-code',
      cliPathOverride: '/release-b/bin/claude',
      wrapperCli: 'release-b-wrapper',
      model: 'candidate-model-b',
    })).toEqual({
      cliId: 'traex',
      cliPathOverride: contract.executable.realpath,
      model: 'candidate-model-a',
    });
  });

  it('restores the Runtime selected by the frozen contract instead of hard-coding Coco', () => {
    const { contract } = fixture();
    const codexContract = { ...contract, runtimeName: 'codex' };
    const restored = {
      session: {
        sessionId: 'session-codex-a',
        chatId: 'oc_shadow',
        rootMessageId: 'om_root',
        title: 'Candidate Codex A',
        status: 'active',
        createdAt: '2026-08-13T00:00:00.000Z',
        workingDir: contract.workspaceSnapshot.realpath,
        cliId: 'codex',
        cliPathOverride: contract.executable.realpath,
        model: contract.model,
        agentFrozen: true,
        candidateRuntimeContract: codexContract,
      },
      larkAppId: 'cli_candidate',
      chatId: 'oc_shadow',
    } as any;

    expect(sessionAgentConfig(restored, {
      cliId: 'coco',
      cliPathOverride: '/ambient/coco',
      model: 'ambient-model',
    })).toEqual({
      cliId: 'codex',
      cliPathOverride: contract.executable.realpath,
      model: contract.model,
    });
  });

  it('attests the real executable, argv, cwd, commit and Skills for fresh and resume', () => {
    const { root, contract } = fixture();
    expect(validateCandidateRuntimeContract(contract, {
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
    }, botmuxIdentity(contract))).toEqual(contract);

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-a',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const adapter = createCocoAdapter(contract.executable.realpath);
    for (const phase of ['fresh', 'resume'] as const) {
      const args = adapter.buildArgs({
        sessionId: 'session-a',
        resume: phase === 'resume',
        workingDir: contract.workspaceSnapshot.realpath,
        model: contract.model,
        disabledFeatures: contract.disabledFeatures,
      });
      expect(args).toContain('--disable');
      expect(args[args.indexOf('--disable') + 1]).toBe('memories');
      const attestation = attestCandidateRuntimeSpawn({
        contract,
        phase,
        sessionId: 'session-a',
        // A daemon restart resets the in-memory generation counter; phase is
        // part of the durable key so resume evidence cannot overwrite fresh.
        workerGeneration: 1,
        bin: adapter.resolvedBin,
        args,
        cwd: contract.workspaceSnapshot.realpath,
        env: { HOME: runtime.home, TRAE_HOME: runtime.traeHome },
        dataDir: root,
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
        ...botmuxIdentity(contract),
      });
      expect(attestation.executable.realpath).toBe(COCO);
      expect(attestation.botmuxCommit).toBe(contract.botmuxCommit);
      expect(attestation.workspace.commit).toBe(contract.workspaceSnapshot.commit);
      expect(attestation.skills.realpath).toBe(contract.skillsRoot);
      expect(attestation.skills.sha256).toBe(contract.skillsSha256);
      expect(attestation.argv).toEqual([COCO, ...args]);
      expect(JSON.parse(readFileSync(candidateRuntimeAttestationPath(root, 'session-a', 1, phase), 'utf8')))
        .toEqual(attestation);
    }
  });

  it.each([
    ['coco', () => createCocoAdapter(COCO)],
    ['codex', () => createCodexAdapter('/release/bin/codex')],
    ['claude-code', () => createClaudeCodeAdapter('/release/bin/claude')],
    ['traex', () => createTraexAdapter(COCO)],
  ])('%s exposes the same unattended Candidate ready/accept/response contract',
    (_runtimeName, createAdapter) => {
      const adapter = createAdapter() as ReturnType<typeof createCocoAdapter> & {
        candidateStartupContract?: unknown;
      };

      expect(adapter.candidateStartupContract).toEqual({
        schemaVersion: 1,
        readyEvidence: 'runtime_ready',
        acceptEvidence: ['cli_transcript', 'native_rpc'],
        responseEvidence: ['cli_transcript_terminal', 'native_rpc_terminal'],
        incompatibleError: 'runtime_incompatible',
        readinessTimeoutMs: 15_000,
      });
    });

  it.each([
    ['coco', 'TRAE_HOME', '.trae'],
    ['codex', 'CODEX_HOME', '.codex'],
    ['claude-code', 'CLAUDE_CONFIG_DIR', '.claude'],
  ])('prepares a fresh isolated %s HOME and release-owned Skills without ambient fallback',
    (runtimeName, runtimeHomeEnv, runtimeHomeDir) => {
      const prepareRuntime = (candidateRuntimeModule as any).prepareCandidateRuntimeHome;
      expect(prepareRuntime).toBeTypeOf('function');
      const { root, contract } = fixture();
      const selected = { ...contract, runtimeName };
      const runtime = prepareRuntime({
        contract: selected,
        dataDir: root,
        sessionId: `session-${runtimeName}`,
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
      }, botmuxIdentity(selected));

      expect(runtime.env.HOME).toBe(runtime.home);
      expect(runtime.env[runtimeHomeEnv]).toBe(join(runtime.home, runtimeHomeDir));
      expect(realpathSync(join(runtime.skillsRoot, 'release-only')))
        .toBe(realpathSync(join(contract.skillsRoot, 'release-only')));
      expect(runtime.home.startsWith(join(root, 'candidate-runtime'))).toBe(true);
    });

  it('persists one release-bound startup proof only after ready, Runtime acceptance, and response', () => {
    const createProbe = (candidateRuntimeModule as any).createCandidateRuntimeStartupProbe;
    expect(createProbe).toBeTypeOf('function');
    const { root, contract } = fixture();
    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-startup-proof',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const probe = createProbe({
      contract,
      runtimeName: 'coco',
      sessionId: 'session-startup-proof',
      workerGeneration: 3,
      phase: 'fresh',
      isolatedHome: runtime.home,
      dataDir: root,
    });

    probe.observeTerminalOutput('runtime booting\n');
    probe.markReady({ kind: 'runtime_ready', evidenceRef: 'pty:ready-pattern' });
    expect(() => probe.markAccepted({
      kind: 'pty_write', nativeSessionId: 'native-a', transcriptRef: 'pty:12',
    })).toThrow(/Runtime acceptance evidence/i);
    probe.markAccepted({
      kind: 'cli_transcript', nativeSessionId: 'native-a', transcriptRef: 'events:user-1',
    });
    probe.markResponse({
      kind: 'cli_transcript_terminal',
      nativeSessionId: 'native-a',
      transcriptRef: 'events:assistant-1',
      output: 'candidate startup probe response',
    });

    const evidence = JSON.parse(readFileSync(probe.evidencePath, 'utf8'));
    expect(evidence).toMatchObject({
      status: 'responded',
      runtimeName: 'coco',
      sessionId: 'session-startup-proof',
      workerGeneration: 3,
      phase: 'fresh',
      releaseId: contract.releaseId,
      releaseManifestSha256: contract.releaseManifestSha256,
      searchRcaCommit: contract.searchRcaCommit,
      botmuxCommit: contract.botmuxCommit,
      botmuxArtifactSha256: contract.botmuxArtifactSha256,
      freshIsolatedEnvironment: true,
      humanInteractionCount: 0,
      taskAcceptedByRuntime: true,
      responseObserved: true,
    });
    expect(evidence.transitions.map((transition: { status: string }) => transition.status))
      .toEqual(['starting', 'ready', 'accepted', 'responded']);
  });

  it('links the host byte-cli credential store into the isolated HOME', () => {
    const { root, contract } = fixture();
    const hostHome = join(root, 'host-home');
    mkdirSync(join(hostHome, '.byte_cli', 'auth'), { recursive: true });
    writeFileSync(join(hostHome, '.byte_cli', 'auth', 'user_jwt_cn.json'), '{"jwt":"fixture"}\n');

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-credential-seed',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      credentialHome: hostHome,
    }, botmuxIdentity(contract));
    const link = join(runtime.home, '.byte_cli', 'auth');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(hostHome, '.byte_cli', 'auth')));
    expect(readFileSync(join(link, 'user_jwt_cn.json'), 'utf8')).toContain('fixture');

    // Resume is idempotent: the same binding validates instead of conflicting.
    const resumed = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-credential-seed',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      credentialHome: hostHome,
    }, botmuxIdentity(contract));
    expect(lstatSync(join(resumed.home, '.byte_cli', 'auth')).isSymbolicLink()).toBe(true);
  });

  it('skips credential seeding when the host store is absent and never destroys live state', () => {
    const { root, contract } = fixture();
    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-credential-absent',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      credentialHome: join(root, 'no-such-host-home'),
    }, botmuxIdentity(contract));
    expect(existsSync(join(runtime.home, '.byte_cli'))).toBe(false);

    // A legacy home with a live (non-empty) local auth directory is kept.
    mkdirSync(join(runtime.home, '.byte_cli', 'auth'), { recursive: true });
    writeFileSync(join(runtime.home, '.byte_cli', 'auth', 'local.json'), '{}\n');
    const hostHome = join(root, 'host-home-2');
    mkdirSync(join(hostHome, '.byte_cli', 'auth'), { recursive: true });
    prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-credential-absent',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      credentialHome: hostHome,
    }, botmuxIdentity(contract));
    const link = join(runtime.home, '.byte_cli', 'auth');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(link, 'local.json'), 'utf8')).toBe('{}\n');
  });

  it('replaces an empty legacy auth directory with the host credential link', () => {
    const { root, contract } = fixture();
    const hostHome = join(root, 'host-home-3');
    mkdirSync(join(hostHome, '.byte_cli', 'auth'), { recursive: true });
    const legacyHome = join(root, 'candidate-runtime', 'session-credential-legacy', 'home');
    mkdirSync(join(legacyHome, '.byte_cli', 'auth'), { recursive: true });

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-credential-legacy',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      credentialHome: hostHome,
    }, botmuxIdentity(contract));
    expect(runtime.home).toBe(legacyHome);
    expect(lstatSync(join(runtime.home, '.byte_cli', 'auth')).isSymbolicLink()).toBe(true);
  });

  it('keeps probe state errors non-fatal across a second turn and a replay attempt', () => {
    const createCoordinator = (candidateRuntimeModule as any).createCandidateRuntimeStartupCoordinator;
    expect(createCoordinator).toBeTypeOf('function');
    const { root, contract } = fixture();
    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-coordinator-replay',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const diagnostics: string[] = [];
    const coordinator = createCoordinator({
      contract,
      runtimeName: 'coco',
      sessionId: 'session-coordinator-replay',
      workerGeneration: 1,
      phase: 'fresh',
      isolatedHome: runtime.home,
      dataDir: root,
      turnId: 'turn-1',
      dispatchAttempt: 1,
      log(message: string) { diagnostics.push(message); },
    });

    coordinator.handleTerminalOutput(
      'Context 100% left',
      createTraexAdapter(COCO),
      { write() {} },
    );
    coordinator.markPromptReady('traex');
    coordinator.recordHumanInteraction();
    coordinator.recordSubmitted({
      turnId: 'turn-1', dispatchAttempt: 1, kind: 'cli_transcript',
      nativeSessionId: 'native-1', transcriptRef: 'rollout-1.jsonl',
    });
    expect(() => coordinator.recordSubmitted({
      turnId: 'turn-1', dispatchAttempt: 2, kind: 'cli_transcript',
      nativeSessionId: 'native-1', transcriptRef: 'rollout-1.jsonl',
    })).not.toThrow();
    coordinator.recordTerminal({
      turnId: 'turn-1', dispatchAttempt: 1, status: 'completed',
      evidence: { nativeSessionId: 'native-1', transcriptRef: 'rollout-1.jsonl' },
    });
    expect(() => coordinator.recordSubmitted({
      turnId: 'turn-2', dispatchAttempt: 1, kind: 'cli_transcript',
      nativeSessionId: 'native-1', transcriptRef: 'rollout-1.jsonl',
    })).not.toThrow();
    expect(diagnostics.some(message => message.includes('ignored'))).toBe(true);
    expect(JSON.parse(readFileSync(coordinator.evidencePath, 'utf8')).humanInteractionCount).toBe(1);
  });

  it.each([
    ['coco', '❯ Continue', () => createCocoAdapter(COCO)],
    ['codex', '› Continue', () => createCodexAdapter('/release/bin/codex')],
    ['traex', '❯ Continue', () => createTraexAdapter(COCO)],
  ])('%s Candidate readiness rejects an unnumbered startup picker cursor',
    (_runtimeName, picker, createAdapter) => {
      const readyOutput = (candidateRuntimeModule as any).candidateRuntimeReadyOutput;
      expect(readyOutput(createAdapter(), `\n${picker}\n`)).toBe(false);
      expect(readyOutput(createAdapter(), '\nContext 100% left\n')).toBe(true);
    });

  it('times out as runtime_incompatible when ready is not followed by Runtime acceptance', async () => {
    vi.useFakeTimers();
    try {
      const { root, contract } = fixture();
      const runtime = prepareCandidateCocoHome({
        contract,
        dataDir: root,
        sessionId: 'session-ready-without-accept',
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
      }, botmuxIdentity(contract));
      const onIncompatible = vi.fn();
      const coordinator = (candidateRuntimeModule as any).createCandidateRuntimeStartupCoordinator({
        contract,
        runtimeName: 'coco',
        sessionId: 'session-ready-without-accept',
        workerGeneration: 1,
        phase: 'fresh',
        isolatedHome: runtime.home,
        dataDir: root,
        turnId: 'turn-ready-without-accept',
        dispatchAttempt: 1,
        readinessTimeoutMs: 25,
        onIncompatible,
      });

      coordinator.handleTerminalOutput(
        'Context 100% left',
        createTraexAdapter(COCO),
        { write() {} },
      );
      await vi.advanceTimersByTimeAsync(25);

      expect(onIncompatible).toHaveBeenCalledTimes(1);
      const evidence = JSON.parse(readFileSync(coordinator.evidencePath, 'utf8'));
      expect(evidence.status).toBe('runtime_incompatible');
      expect(evidence.transitions.map((entry: { status: string }) => entry.status))
        .toEqual(['starting', 'ready', 'runtime_incompatible']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an unknown unnumbered TRAE startup picker under the fail-fast timer', async () => {
    vi.useFakeTimers();
    try {
      const { root, contract } = fixture();
      const runtime = prepareCandidateCocoHome({
        contract,
        dataDir: root,
        sessionId: 'session-unknown-trae-picker',
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
      }, botmuxIdentity(contract));
      const onIncompatible = vi.fn();
      const coordinator = (candidateRuntimeModule as any).createCandidateRuntimeStartupCoordinator({
        contract,
        runtimeName: 'coco',
        sessionId: 'session-unknown-trae-picker',
        workerGeneration: 1,
        phase: 'fresh',
        isolatedHome: runtime.home,
        dataDir: root,
        turnId: 'turn-unknown-picker',
        dispatchAttempt: 1,
        readinessTimeoutMs: 25,
        onIncompatible,
      });

      coordinator.handleTerminalOutput(
        '\n❯ Continue\n',
        createTraexAdapter(COCO),
        { write() {} },
      );
      await vi.advanceTimersByTimeAsync(25);

      expect(onIncompatible).toHaveBeenCalledTimes(1);
      const evidence = JSON.parse(readFileSync(coordinator.evidencePath, 'utf8'));
      expect(evidence.transitions.map((entry: { status: string }) => entry.status))
        .toEqual(['starting', 'runtime_incompatible']);
      expect(evidence.diagnostic.terminalTail).toContain('❯ Continue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails an unknown startup interaction quickly as runtime_incompatible with terminal diagnostics', async () => {
    vi.useFakeTimers();
    try {
      const createProbe = (candidateRuntimeModule as any).createCandidateRuntimeStartupProbe;
      expect(createProbe).toBeTypeOf('function');
      const { root, contract } = fixture();
      const runtime = prepareCandidateCocoHome({
        contract,
        dataDir: root,
        sessionId: 'session-unknown-ui',
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
      }, botmuxIdentity(contract));
      const onIncompatible = vi.fn();
      const probe = createProbe({
        contract,
        runtimeName: 'future-runtime',
        sessionId: 'session-unknown-ui',
        workerGeneration: 1,
        phase: 'fresh',
        isolatedHome: runtime.home,
        dataDir: root,
        readinessTimeoutMs: 25,
        onIncompatible,
      });
      probe.observeTerminalOutput('Choose a migration source:\n  1. unknown-host-state\n');

      await vi.advanceTimersByTimeAsync(25);

      expect(onIncompatible).toHaveBeenCalledTimes(1);
      const evidence = JSON.parse(readFileSync(probe.evidencePath, 'utf8'));
      expect(evidence.status).toBe('runtime_incompatible');
      expect(evidence.taskAcceptedByRuntime).toBe(false);
      expect(evidence.responseObserved).toBe(false);
      expect(evidence.diagnostic.terminalTail).toContain('Choose a migration source');
      expect(evidence.diagnostic.readinessTimeoutMs).toBe(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('automates only the shared known trust prompt without counting a human interaction', () => {
    const createHandler = (candidateRuntimeModule as any).createCandidateRuntimeStartupInteractionHandler;
    expect(createHandler).toBeTypeOf('function');
    const writes: string[] = [];
    const handler = createHandler();
    const pty = { write(value: string) { writes.push(value); } };

    expect(handler.handle('❯ 1. Yes, continue\n2. No, quit', pty)).toBe(true);
    expect(handler.handle('❯ 1. Yes, continue\n2. No, quit', pty)).toBe(false);
    expect(handler.handle('Choose an unknown migration source', pty)).toBe(false);
    expect(writes).toEqual(['\r']);
    expect(handler.humanInteractionCount).toBe(0);
    expect(handler.automatedInteractionCount).toBe(1);
  });

  it('opts the isolated Candidate home out of Coco legacy migration before spawn', () => {
    const { root, contract } = fixture();
    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-migration',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const adapter = createCocoAdapter(contract.executable.realpath);
    const args = adapter.buildArgs({
      sessionId: 'session-migration',
      resume: false,
      workingDir: contract.workspaceSnapshot.realpath,
      model: contract.model,
      disabledFeatures: contract.disabledFeatures,
    });
    const attestation = attestCandidateRuntimeSpawn({
      contract,
      phase: 'fresh',
      sessionId: 'session-migration',
      workerGeneration: 1,
      bin: adapter.resolvedBin,
      args,
      cwd: contract.workspaceSnapshot.realpath,
      env: { HOME: runtime.home, TRAE_HOME: runtime.traeHome },
      dataDir: root,
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
      ...botmuxIdentity(contract),
    });

    expect(readFileSync(contract.executable.realpath)
      .includes(Buffer.from('.coco-migration-skip-all'))).toBe(true);
    expect(attestation.argv).toEqual([contract.executable.realpath, ...args]);
    expect(readFileSync(join(runtime.traeHome, '.coco-migration-skip-all'), 'utf8')).toBe('');
  });

  it('fails closed before spawn when executable, commit, or Skills drift', () => {
    const executableDrift = fixture();
    const executableRuntime = prepareCandidateCocoHome({
      contract: executableDrift.contract,
      dataDir: executableDrift.root,
      sessionId: 'session-executable-drift',
      authFile: join(executableDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(executableDrift.root),
    }, botmuxIdentity(executableDrift.contract));
    expect(() => attestCandidateRuntimeSpawn({
      contract: {
        ...executableDrift.contract,
        executable: { ...executableDrift.contract.executable, sha256: 'f'.repeat(64) },
      },
      phase: 'resume',
      sessionId: 'session-executable-drift',
      workerGeneration: 2,
      bin: executableDrift.contract.executable.realpath,
      args: ['--resume', 'session-executable-drift', '--disable', 'memories'],
      cwd: executableDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: executableRuntime.home, TRAE_HOME: executableRuntime.traeHome },
      dataDir: executableDrift.root,
      authFile: join(executableDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(executableDrift.root),
      ...botmuxIdentity(executableDrift.contract),
    })).toThrow(/executable attestation mismatch/);

    const commitDrift = fixture();
    const commitRuntime = prepareCandidateCocoHome({
      contract: commitDrift.contract,
      dataDir: commitDrift.root,
      sessionId: 'session-commit-drift',
      authFile: join(commitDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(commitDrift.root),
    }, botmuxIdentity(commitDrift.contract));
    writeFileSync(join(commitDrift.contract.workspaceSnapshot.realpath, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
    expect(() => attestCandidateRuntimeSpawn({
      contract: commitDrift.contract,
      phase: 'resume',
      sessionId: 'session-commit-drift',
      workerGeneration: 2,
      bin: commitDrift.contract.executable.realpath,
      args: ['--resume', 'session-commit-drift', '--disable', 'memories'],
      cwd: commitDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: commitRuntime.home, TRAE_HOME: commitRuntime.traeHome },
      dataDir: commitDrift.root,
      authFile: join(commitDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(commitDrift.root),
      ...botmuxIdentity(commitDrift.contract),
    })).toThrow(/workspace commit mismatch/);

    const skillsDrift = fixture();
    const runtime = prepareCandidateCocoHome({
      contract: skillsDrift.contract,
      dataDir: skillsDrift.root,
      sessionId: 'session-skills-drift',
      authFile: join(skillsDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(skillsDrift.root),
    }, botmuxIdentity(skillsDrift.contract));
    writeFileSync(join(skillsDrift.contract.skillsRoot, 'release-only', 'SKILL.md'), '# drifted\n');
    expect(() => attestCandidateRuntimeSpawn({
      contract: skillsDrift.contract,
      phase: 'resume',
      sessionId: 'session-skills-drift',
      workerGeneration: 2,
      bin: skillsDrift.contract.executable.realpath,
      args: ['--resume', 'session-skills-drift', '--disable', 'memories'],
      cwd: skillsDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: runtime.home, TRAE_HOME: runtime.traeHome },
      dataDir: skillsDrift.root,
      authFile: join(skillsDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(skillsDrift.root),
      ...botmuxIdentity(skillsDrift.contract),
    })).toThrow(/Skills digest mismatch/);
  });

  it('real Coco binary excludes poison Memory and host Skill while keeping the frozen Release Skill', async () => {
    const { root, contract } = fixture();
    const hostTrae = join(root, 'host-trae');
    const hostHome = join(root, 'host-home');
    mkdirSync(join(hostTrae, 'cli', 'memories'), { recursive: true });
    mkdirSync(join(hostTrae, 'skills', 'host-poison'), { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    writeFileSync(join(hostTrae, 'cli', 'memories', 'memory_summary.md'), 'HOST_POISON_MEMORY_714cd9\n');
    writeFileSync(join(hostTrae, 'cli', 'memories', 'MEMORY.md'), 'HOST_POISON_MEMORY_714cd9\n');
    writeFileSync(join(hostTrae, 'skills', 'host-poison', 'SKILL.md'), [
      '---',
      'name: host-poison',
      'description: HOST_POISON_SKILL_8fd933',
      '---',
      '# host poison',
      '',
    ].join('\n'));

    const enabled = (await exec(COCO, ['debug', 'prompt-input', 'probe'], {
      cwd: contract.workspaceSnapshot.realpath,
      env: { ...process.env, HOME: hostHome, TRAE_HOME: hostTrae },
      encoding: 'utf8',
    })).stdout;
    expect(enabled).toContain('HOST_POISON_MEMORY_714cd9');
    expect(enabled).toContain('HOST_POISON_SKILL_8fd933');

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-poison',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const isolated = (await exec(COCO, ['--disable', 'memories', 'debug', 'prompt-input', 'probe'], {
      cwd: contract.workspaceSnapshot.realpath,
      env: { ...process.env, HOME: runtime.home, TRAE_HOME: runtime.traeHome },
      encoding: 'utf8',
    })).stdout;
    expect(isolated).not.toContain('HOST_POISON_MEMORY_714cd9');
    expect(isolated).not.toContain('HOST_POISON_SKILL_8fd933');
    expect(isolated).toContain('RELEASE_ONLY_SKILL_bfe24a');
  });
});
