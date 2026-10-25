/**
 * N1 regression with a REAL worker (real worker.ts + real PTY spawn):
 *
 * The daemon publishes the opening turn identity at ACCEPT time, before the
 * worker fork exists and therefore before any session_identity_decision report
 * — it writes the fail-closed single root file. A markerless first SINGLE init
 * in the worker used to reset ALL artifacts (the F2 follow-up), wiping that
 * accept-time file so the very first tool call returned 77.
 *
 * These cases drive the actual spawn:
 *  - single (apiOnly session ⇒ structurally single): the pre-fork root token
 *    MUST survive worker init, and the worker reports single;
 *  - proven (managed binding, no sandbox): the pre-fork single file is
 *    cleared by the proven init (correct), and the worker reports proven so
 *    the daemon flip handler can replay into memory (that replay itself is
 *    covered in identity-decision-flip.test.ts).
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  sessionIdentityDataDir,
  sessionIdentityPath,
  writeSessionIdentity,
  recallProvenIdentityContent,
  clearSingleIdentityArtifacts,
  forgetProvenIdentityContent,
} from '../src/core/cli-identity.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';

/** Extract the REAL handleIdentityDecisionFlip from daemon.ts so the
 *  composition (purge → live gate → proven memory) is production code, not a
 *  copy. Same source-extraction technique as identity-decision-flip. */
function extractFlipHandler() {
  const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');
  const ast = ts.createSourceFile('daemon.ts', daemonSource, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleIdentityDecisionFlip',
  );
  if (!node) throw new Error('Missing handleIdentityDecisionFlip');
  const text = ts.transpileModule(node.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return (ds: any, context: any, deps: any) =>
    new Function('deps', 'with (deps) { ' + text + '; return handleIdentityDecisionFlip; }')(deps)(ds, context);
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSandboxScratch(dir);
  tempDirs.clear();
});

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

interface WorkerHandle {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  root: string;
  sessionId: string;
  fakeBin: string;
}

function spawnIdentityWorker(opts: { apiOnly: boolean }): WorkerHandle {
  const root = mkdtempSync(join(tmpdir(), 'botmux-first-turn-'));
  tempDirs.add(root);
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(fakeCli, 0o755);

  const fakeBin = join(root, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  for (const name of ['bytedcli', 'codebase']) {
    writeFileSync(join(fakeBin, name), '#!/bin/sh\necho real\n');
    chmodSync(join(fakeBin, name), 0o755);
  }

  const sessionId = `firstturn${Date.now().toString(36)}${process.pid.toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_first_turn',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));

  // Simulate the daemon's ACCEPT-time publication, which lands BEFORE the
  // fork: a single root file, no identity-layout marker yet.
  writeSessionIdentity(root, sessionId, {
    tool: 'bytedcli', cloudJwt: 'OPENING-TURN-JWT', turnId: 'first-turn', openId: 'ou_opener',
  }, 'single');
  const dataDir = sessionIdentityDataDir(root, sessionId);
  expect(existsSync(join(dataDir, 'identity-layout'))).toBe(false);

  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_first_turn',
    rootMessageId: 'om_first_turn',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: 'first-turn',
    larkAppId: 'app_first_turn',
    larkAppSecret: 'secret',
    apiOnly: opts.apiOnly,
    triggerUserAuth: { enabled: true, tools: ['bytedcli'], fallback: 'none' },
  } satisfies DaemonToWorker);

  return { child, logs, messages, root, sessionId, fakeBin };
}

async function waitForDecision(h: WorkerHandle, model: 'single' | 'proven'): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      throw new Error(`worker exited early\n${h.logs.join('')}`);
    }
    if (h.messages.some(m => m.type === 'session_identity_decision' && m.model === model)) return;
    await delay(50);
  }
  throw new Error(`no ${model} session_identity_decision\n${h.logs.join('')}`);
}

describe.skipIf(process.platform !== 'linux')('opening-turn identity survives the real worker spawn (N1)', () => {
  it('single init keeps the accept-time root file so the first turn is not denied', async () => {
    // apiOnly ⇒ structurally single on every platform path; no sandbox involved.
    const h = spawnIdentityWorker({ apiOnly: true });
    await waitForDecision(h, 'single');
    // Give prepareTriggerUserCliEnv (which runs right around the decision
    // send) a beat to finish writing the layout.
    await delay(300);

    const dataDir = sessionIdentityDataDir(h.root, h.sessionId);
    expect(readFileSync(join(dataDir, 'identity-layout'), 'utf8').trim()).toBe('single-v1');
    // The N1 invariant: the token the daemon wrote at accept time survives.
    expect(readFileSync(sessionIdentityPath(h.root, h.sessionId, 'bytedcli'), 'utf8'))
      .toContain('OPENING-TURN-JWT');
  }, 45_000);

  it('proven init clears the pre-fork single file and the daemon flip replays opening-turn content (N1/P2)', async () => {
    const h = spawnIdentityWorker({ apiOnly: false });
    await waitForDecision(h, 'proven');
    await delay(300);

    const dataDir = sessionIdentityDataDir(h.root, h.sessionId);
    expect(readFileSync(join(dataDir, 'identity-layout'), 'utf8').trim()).toBe('proven-v1');
    // Proven keeps no plaintext — the fail-closed single accept file is
    // removed entirely (proven init creates no root token placeholder).
    expect(existsSync(sessionIdentityPath(h.root, h.sessionId, 'bytedcli'))).toBe(false);

    // The worker named its spawn turn on the decision (the P2 fact: at the
    // opening boundary no daemon live-turn field points at it yet).
    const decision = h.messages.findLast(m => m.type === 'session_identity_decision') as any;
    expect(decision.turnId).toBe('first-turn');

    // Run the REAL daemon flip handler against REAL identity storage, with a
    // replay that republishes the opening turn the way refreshTurnCliIdentity
    // does. Composition proves: purge plaintext → proven memory holds the
    // opening turn (what the proven cli-identity-runner then fetches).
    const flip = extractFlipHandler();
    const ds: any = {
      session: { sessionId: h.sessionId, status: 'active' },
      larkAppId: 'app_first_turn', chatId: 'oc_first_turn',
      worker: { killed: false },
      lastPublishedIdentityModel: 'single',
    };
    const deps = {
      config: { session: { dataDir: h.root } },
      logger: { error: () => {} },
      clearSingleIdentityArtifacts,
      forgetProvenIdentityContent,
      identityDecisionTurnIsLive: () => true,
      refreshTurnCliIdentity: async (target: any, turnId: string) => {
        // Replay republishes the opening turn the accept-time single write
        // carried, now under proven.
        writeSessionIdentity(h.root, target.session.sessionId, {
          tool: 'bytedcli', cloudJwt: 'OPENING-TURN-JWT', turnId, openId: 'ou_opener',
        }, 'proven');
        target.lastPublishedIdentityModel = 'proven';
      },
    };
    await flip(ds, { model: 'proven', flipped: true, turnId: 'first-turn' }, deps);
    expect(existsSync(sessionIdentityPath(h.root, h.sessionId, 'bytedcli'))).toBe(false);
    expect(recallProvenIdentityContent(h.root, h.sessionId, 'first-turn', 'bytedcli'))
      .toContain('OPENING-TURN-JWT');
  }, 45_000);
});
