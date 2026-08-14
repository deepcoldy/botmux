import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateRuntimeCliId, hashCandidateRuntimeTree } from '../src/services/candidate-runtime-contract.js';
import type { CandidateRuntimeContract } from '../src/services/candidate-runtime-contract.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const SOURCE_ROOT = resolve('.');
const COCO = realpathSync(join(process.env.HOME || '/home/zhubowen.cc', '.local', 'bin', 'coco'));
const children = new Set<ChildProcess>();
const temporaryRoots = new Set<string>();

type BuildManifest = {
  schemaVersion: 1;
  botmuxCommit: string;
  treeSha256: string;
  files: Array<{ path: string; sha256: string }>;
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function buildTemporaryBotmuxRelease(root: string): {
  root: string;
  commit: string;
  manifest: BuildManifest;
} {
  const releaseRoot = join(root, 'botmux-release');
  mkdirSync(releaseRoot, { recursive: true });
  for (const entry of ['src', 'scripts', 'package.json', 'tsconfig.json', '.gitignore']) {
    cpSync(join(SOURCE_ROOT, entry), join(releaseRoot, entry), { recursive: true });
  }
  symlinkSync(join(SOURCE_ROOT, 'node_modules'), join(releaseRoot, 'node_modules'), 'dir');
  git(releaseRoot, ['init', '-q']);
  git(releaseRoot, ['config', 'user.email', 'candidate-startup-e2e@example.invalid']);
  git(releaseRoot, ['config', 'user.name', 'Candidate Startup E2E']);
  git(releaseRoot, ['remote', 'add', 'origin', 'ssh://example.invalid/botmux-candidate-release.git']);
  git(releaseRoot, ['add', '.']);
  git(releaseRoot, ['commit', '-qm', 'test: freeze candidate startup release']);
  const commit = git(releaseRoot, ['rev-parse', 'HEAD']);

  execFileSync('pnpm', ['build'], {
    cwd: releaseRoot,
    env: { ...process.env, BOTMUX_NO_CLAIM: '1' },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const manifest = JSON.parse(
    readFileSync(join(releaseRoot, 'dist', 'botmux-build-manifest.json'), 'utf8'),
  ) as BuildManifest;
  return { root: releaseRoot, commit, manifest };
}

async function waitFor<T>(
  read: () => T | undefined,
  child: ChildProcess,
  logs: string[],
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited before ${label} (${child.exitCode ?? child.signalCode})\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Worker evidence was not observed for ${label} within ${timeoutMs}ms\n${logs.join('')}`);
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.send({ type: 'close' } satisfies DaemonToWorker); } catch { /* already disconnected */ }
  await Promise.race([
    new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

afterEach(async () => {
  await Promise.all([...children].map(stopWorker));
  children.clear();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe('Candidate production Runtime startup', () => {
  it('starts the selected real Runtime unattended through the compiled production worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-worker-startup-e2e-'));
    temporaryRoots.add(root);
    const release = buildTemporaryBotmuxRelease(root);
    expect(release.manifest).toMatchObject({
      schemaVersion: 1,
      botmuxCommit: release.commit,
      treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(release.manifest.files.some(file => file.path === 'worker.js')).toBe(true);

    const dataDir = join(root, 'data');
    const skills = join(root, 'release-skills');
    const workspace = join(root, 'target-workspace');
    const capabilityLock = join(root, 'capability-lock.json');
    const releaseManifest = join(root, 'release-manifest.json');
    mkdirSync(join(skills, 'release-only'), { recursive: true });
    mkdirSync(join(workspace, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(skills, 'release-only', 'SKILL.md'), '---\nname: release-only\ndescription: release-only\n---\n');
    writeFileSync(capabilityLock, '{"schemaVersion":1}\n');
    const workspaceCommit = 'c'.repeat(40);
    const searchRcaCommit = 'd'.repeat(40);
    const workspaceRepository = 'ssh://example.invalid/candidate-startup-target.git';
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(workspace, '.git', 'refs', 'heads', 'main'), `${workspaceCommit}\n`);
    writeFileSync(join(workspace, '.git', 'config'), `[remote "origin"]\n\turl = ${workspaceRepository}\n`);
    writeFileSync(releaseManifest, `${JSON.stringify({
      releaseId: 'candidate-worker-startup-e2e',
      searchRcaCommit,
      botmuxCommit: release.commit,
      botmuxArtifactSha256: release.manifest.treeSha256,
    })}\n`);

    const sessionId = randomUUID();
    const turnId = `startup-turn-${randomUUID()}`;
    const responseToken = `CANDIDATE_RUNTIME_READY_${randomUUID().replaceAll('-', '')}`;
    const prompt = `Reply with exactly this token and nothing else: ${responseToken}`;
    const contract: CandidateRuntimeContract = {
      schemaVersion: 1,
      incidentKey: `startup-e2e:${sessionId}`,
      eventId: `event-${sessionId}`,
      candidateDispatchId: `cand_${sessionId.replaceAll('-', '')}`,
      releaseId: `release-${sessionId}`,
      releaseManifestSha256: sha256(releaseManifest),
      runtimeBundleId: `runtime-${sessionId}`,
      runtimeName: 'coco',
      searchRcaCommit,
      botmuxCommit: release.commit,
      botmuxArtifactSha256: release.manifest.treeSha256,
      workspaceSnapshot: {
        realpath: realpathSync(workspace),
        repository: workspaceRepository,
        commit: workspaceCommit,
      },
      capabilityLockSha256: sha256(capabilityLock),
      skillsRoot: realpathSync(skills),
      skillsSha256: hashCandidateRuntimeTree(skills),
      executable: { realpath: COCO, sha256: sha256(COCO) },
      disabledFeatures: ['memories'],
      investigation: {
        title: 'Candidate Runtime startup E2E',
        symptom: 'production worker startup contract probe',
        preparedInput: { content: prompt },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'cli_candidate_e2e', chatId: 'oc_candidate_e2e' },
    };
    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const child = spawn(process.execPath, [join(release.root, 'dist', 'worker.js')], {
      cwd: workspace,
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: contract.shadowTarget.larkAppId,
        LARK_APP_SECRET: 'candidate-worker-startup-e2e-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: contract.shadowTarget.chatId,
      rootMessageId: 'om_candidate_worker_startup_e2e',
      workingDir: contract.workspaceSnapshot.realpath,
      cliId: candidateRuntimeCliId(contract.runtimeName),
      cliPathOverride: contract.executable.realpath,
      backendType: 'pty',
      prompt,
      larkAppId: contract.shadowTarget.larkAppId,
      larkAppSecret: 'candidate-worker-startup-e2e-secret',
      turnId,
      dispatchAttempt: 1,
      candidateRuntimeContract: contract,
      workerGeneration: 1,
    };
    child.send(init);

    await waitFor(
      () => messages.find(message => message.type === 'ready'),
      child,
      logs,
      30_000,
      'worker ready',
    );
    const submitted = await waitFor(
      () => messages.find(message => message.type === 'turn_submitted'
        && message.turnId === turnId),
      child,
      logs,
      30_000,
      'Runtime transcript acceptance',
    );
    expect(submitted).toMatchObject({
      type: 'turn_submitted',
      turnId,
      dispatchAttempt: 1,
      evidenceKind: 'cli_transcript',
    });
    if (submitted.type !== 'turn_submitted') throw new Error('unreachable');
    expect(submitted.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const separator = submitted.transcriptRef.lastIndexOf(':');
    expect(separator).toBeGreaterThan(0);
    const rollout = submitted.transcriptRef.slice(0, separator);
    expect(realpathSync(rollout).startsWith(realpathSync(join(
      dataDir,
      'candidate-runtime',
      sessionId,
      'home',
      '.trae',
      'cli',
      'sessions',
    )))).toBe(true);
    expect(readFileSync(rollout, 'utf8')).toContain(prompt);

    const terminal = await waitFor(
      () => messages.find(message => message.type === 'turn_terminal'
        && message.turnId === turnId),
      child,
      logs,
      50_000,
      'Runtime terminal response',
    );
    expect(terminal).toMatchObject({
      type: 'turn_terminal',
      turnId,
      dispatchAttempt: 1,
      status: 'completed',
      nativeSessionId: submitted.nativeSessionId,
    });

    const startupProofPath = join(
      dataDir,
      'candidate-runtime',
      sessionId,
      'startup-probes',
      '1-fresh.json',
    );
    const startupProof = await waitFor(
      () => {
        if (!existsSync(startupProofPath)) return undefined;
        const evidence = JSON.parse(readFileSync(startupProofPath, 'utf8'));
        return evidence.status === 'responded' ? evidence : undefined;
      },
      child,
      logs,
      10_000,
      'persisted startup response proof',
    );
    expect(startupProof).toMatchObject({
      status: 'responded',
      runtimeName: contract.runtimeName,
      sessionId,
      workerGeneration: 1,
      phase: 'fresh',
      releaseId: contract.releaseId,
      releaseManifestSha256: contract.releaseManifestSha256,
      runtimeBundleId: contract.runtimeBundleId,
      searchRcaCommit: contract.searchRcaCommit,
      botmuxCommit: release.commit,
      botmuxArtifactSha256: release.manifest.treeSha256,
      freshIsolatedEnvironment: true,
      humanInteractionCount: 0,
      taskAcceptedByRuntime: true,
      responseObserved: true,
    });
    expect(startupProof.transitions.map((transition: { status: string }) => transition.status))
      .toEqual(['starting', 'ready', 'accepted', 'responded']);
    expect(startupProof.transitions.at(-1)?.evidence?.output).toContain(responseToken);
  }, 150_000);
});
