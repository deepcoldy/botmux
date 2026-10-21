import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import {
  createLinkRefRuntime,
  setLinkRefRuntime,
  type LinkRefRuntime,
} from '../src/services/link-ref-runtime.js';
import type { LinkRefDiagnostic, LinkRefTurnKey } from '../src/services/link-ref-types.js';
import type { CliTurnPayload } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const dacuHost = 'source.example.test';
const dacuBaseUrl = `https://${dacuHost}/preview_platform/problem`;
const dacuUrl = `${dacuBaseUrl}?problemId=e2e%2Fcase&source=&source=timeline#timeline`;
const authorizationUrl = 'https://auth.example.test/authorize'
  + '?code=one&token=two&signature=three&state=four'
  + '&redirect_uri=https%3A%2F%2Fclient.example.test%2Fdone';
const bearerSecret = 'Bearer e2e-private-credential';
const unknownRef = 'lr_ffffffffffffffffffffffffffffffff';
const hostSecret = 'link-ref-e2e-host-secret';

interface FixtureState {
  root: string;
  dataDir: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt: number;
  appId: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  providerRequests: string[];
}

let ipc: IpcServerHandle | undefined;
let runtime: LinkRefRuntime | undefined;
const roots: string[] = [];

function makeFixture(): FixtureState {
  const root = mkdtempSync(join(tmpdir(), 'botmux-link-ref-e2e-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const sessionId = 'session_link_ref_e2e';
  const turnId = 'turn_link_ref_e2e';
  const dispatchAttempt = 4;
  const appId = 'link_ref_e2e_app';
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
    sessionId,
    turnId,
    linkRefMode: 'enabled',
  }));
  mkdirSync(join(root, '.botmux'), { recursive: true });
  writeFileSync(join(root, '.botmux', '.dashboard-secret'), hostSecret, { mode: 0o600 });
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: appId,
    larkAppSecret: 'test-secret',
    cliId: 'codex',
    replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, appId, { [sessionId]: {
    sessionId,
    status: 'active',
    cliId: 'codex',
    larkAppId: appId,
    chatId: 'oc_link_ref_e2e',
    rootMessageId: 'om_link_ref_e2e',
    scope: 'thread',
    chatType: 'group',
    workingDir: root,
  } });
  return { root, dataDir, sessionId, turnId, dispatchAttempt, appId };
}

function runCli(
  state: FixtureState,
  args: string[],
  ipcPort: number,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(fixture, args, {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: state.root,
        SESSION_DATA_DIR: state.dataDir,
        BOTS_CONFIG: join(state.root, 'bots.json'),
        BOTMUX_SESSION_ID: state.sessionId,
        BOTMUX_TURN_ID: state.turnId,
        BOTMUX_LARK_APP_ID: state.appId,
        BOTMUX_DAEMON_IPC_PORT: String(ipcPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout,
        stderr,
        providerRequests: stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY=')),
      });
    });
  });
}

function placeholderFrom(companion: string): string {
  const refId = companion.match(/lr_[0-9a-f]{32}/)?.[0];
  if (!refId) throw new Error('companion did not contain a LinkRef');
  return `{{botmux_link:${refId}}}`;
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function storedBytes(root: string): Buffer {
  const chunks: Buffer[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) chunks.push(readFileSync(path));
    }
  };
  visit(root);
  return Buffer.concat(chunks);
}

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = undefined;
  runtime?.close();
  runtime = undefined;
  setLinkRefRuntime(undefined);
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LinkRef end-to-end URL integrity', () => {
  it('preserves registered URLs through authenticated final delivery without changing ordinary URLs', async () => {
    const state = makeFixture();
    const key: LinkRefTurnKey = {
      appId: state.appId,
      sessionId: state.sessionId,
      turnId: state.turnId,
      dispatchAttempt: state.dispatchAttempt,
    };
    const diagnostics: LinkRefDiagnostic[] = [];
    runtime = createLinkRefRuntime(state.dataDir, {
      onDiagnostic: event => diagnostics.push(event),
    });
    setLinkRefRuntime(runtime);

    const payload: CliTurnPayload = {
      content: dacuUrl,
      codexAppInput: { text: dacuUrl },
      linkRefs: {
        mode: 'enabled',
        sources: [{ sourceType: 'user_message', kind: 'text', text: dacuUrl }],
      },
    };
    const prepared = runtime.prepareTurn({ key, mode: 'enabled', payload });
    expect(prepared.codexAppInput?.text).toBe(dacuUrl);
    expect(prepared.content).toContain('<botmux_link_refs>');
    expect(prepared.content).toContain(dacuUrl);
    const dacuPlaceholder = placeholderFrom(prepared.content);

    const authorization = runtime.registerSources({
      key,
      mode: 'enabled',
      sources: [{
        sourceType: 'tool',
        kind: 'structured',
        value: {
          authorization_url: authorizationUrl,
          headers: { authorization: bearerSecret },
        },
      }],
    });
    expect(authorization.stats.found).toBe(1);
    expect(authorization.stats.filteredCredential).toBeGreaterThanOrEqual(1);
    expect(authorization.companion).toContain(authorizationUrl);
    expect(authorization.companion).not.toContain(bearerSecret);
    const authorizationPlaceholder = placeholderFrom(authorization.companion!);

    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(sessionId => (
      sessionId === state.sessionId
        ? {
            session: { sessionId, status: 'active' },
            larkAppId: state.appId,
            managedTurnOrigin: {
              capability: 'ab'.repeat(32),
              turnId: state.turnId,
              dispatchAttempt: state.dispatchAttempt,
              linkRefMode: 'enabled',
            },
          } as never
        : undefined
    ));
    setIpcAuthSecret(hostSecret);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    const final = await runCli(state, [
      'send', '--no-mention', '--response-kind', 'final',
      dacuPlaceholder, '--expected-link', dacuPlaceholder,
    ], ipc.port);
    expect(final.code, final.stderr).toBe(0);
    expect(final.providerRequests).toHaveLength(1);
    expect(countOccurrences(final.providerRequests[0]!, dacuUrl)).toBe(1);
    expect(final.providerRequests[0]).not.toContain(dacuPlaceholder);

    // A retry that uses the already-expanded bytes must hit the same final
    // fingerprint and replay without a second provider request.
    const replay = await runCli(state, [
      'send', '--no-mention', '--response-kind', 'final',
      dacuUrl, '--expected-link', dacuUrl,
    ], ipc.port);
    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.providerRequests).toHaveLength(0);

    const base = await runCli(state, [
      'send', '--no-mention', '--response-kind', 'auxiliary',
      dacuBaseUrl, '--expected-link', dacuBaseUrl,
    ], ipc.port);
    expect(base.code, base.stderr).toBe(0);
    expect(base.providerRequests).toHaveLength(1);
    expect(countOccurrences(base.providerRequests[0]!, dacuBaseUrl)).toBe(1);
    expect(base.providerRequests[0]).not.toContain('#timeline');

    const authorizationSend = await runCli(state, [
      'send', '--no-mention', '--response-kind', 'auxiliary',
      authorizationPlaceholder, '--expected-link', authorizationPlaceholder,
    ], ipc.port);
    expect(authorizationSend.code, authorizationSend.stderr).toBe(0);
    expect(authorizationSend.providerRequests).toHaveLength(1);
    expect(countOccurrences(authorizationSend.providerRequests[0]!, authorizationUrl)).toBe(1);
    expect(authorizationSend.providerRequests[0]).not.toContain(authorizationPlaceholder);

    const unknown = await runCli(state, [
      'send', '--no-mention', '--response-kind', 'auxiliary',
      `{{botmux_link:${unknownRef}}}`,
    ], ipc.port);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('botmux send refused: link_ref_unknown');
    expect(unknown.providerRequests).toHaveLength(0);

    const diagnosticOutput = JSON.stringify(diagnostics);
    expect(diagnosticOutput).not.toContain(bearerSecret);
    expect(diagnosticOutput).not.toContain('auth.example.test');
    runtime.close();
    runtime = undefined;
    const ledgerBytes = storedBytes(join(state.dataDir, 'link-refs'));
    expect(ledgerBytes.includes(Buffer.from(bearerSecret))).toBe(false);
    expect(ledgerBytes.includes(Buffer.from(authorizationUrl))).toBe(true);

  });
});
