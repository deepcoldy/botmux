import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports, spawnTsScript } from './helpers/ts-runner.js';
import { NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS, signNativeSubagentRuntimeResponse, writeNativeSubagentRuntimeResponseProof } from '../src/core/native-subagent-runtime-ipc-auth.js';
import {
  ensureManagedOriginAttestationDirectory,
  managedOriginCapabilityPath,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';

const CLI = resolve('src/cli.ts');
const CAPABILITY = 'ab'.repeat(32);
const POLICY_CAPABILITY = 'ef'.repeat(32);
const HOST_SECRET = 'native-runtime-test-host-secret';
const APP_ID = 'app-native';
const BOOT_ID = 'B'.repeat(43);
const CHANNEL_ID = 'cd'.repeat(32);
let server: Server | undefined;
let dir: string | undefined;
let capturedRequests: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];

afterEach(async () => {
  if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function listen(options: {
  policy?: unknown;
  status?: number;
  response?: unknown;
  authKind?: 'host' | 'capability';
  signResponse?: boolean;
  responseKey?: string;
  responseMode?: 'normal' | 'oversized-never-ending' | 'partial-never-ending';
  writeHostProof?: boolean;
}): Promise<number> {
  if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    capturedRequests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
    const status = options.status ?? 200;
    const raw = JSON.stringify(options.response ?? (status === 200
      ? { ok: true, policy: options.policy }
      : { ok: false }));
    const nonce = req.headers[NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.nonce];
    const port = (server!.address() as { port: number }).port;
    const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
    if (options.signResponse !== false && typeof nonce === 'string') {
      responseHeaders[NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.responseSignature] =
        signNativeSubagentRuntimeResponse({
          key: options.responseKey ?? ((options.authKind ?? 'capability') === 'host' ? HOST_SECRET : CAPABILITY),
          requestNonce: nonce,
          method: 'POST',
          path: '/api/sessions/session-native/native-subagent-runtime',
          port,
          status,
          body: raw,
          sessionId: 'session-native',
          larkAppId: APP_ID,
          bootInstanceId: BOOT_ID,
        });
    }
    if ((options.authKind ?? 'capability') === 'capability'
      && options.writeHostProof !== false && typeof nonce === 'string') {
      writeNativeSubagentRuntimeResponseProof({
        dataDir: dir!, channelId: CHANNEL_ID, nonce,
        response: {
          method: 'POST', path: '/api/sessions/session-native/native-subagent-runtime',
          port, status, body: raw, sessionId: 'session-native',
          larkAppId: APP_ID, bootInstanceId: BOOT_ID,
        },
      });
    }
    res.writeHead(status, responseHeaders);
    if (options.responseMode === 'oversized-never-ending') {
      res.write(Buffer.alloc(16 * 1024));
      res.write(Buffer.from([1]));
      return;
    }
    if (options.responseMode === 'partial-never-ending') {
      res.write('{');
      return;
    }
    res.end(raw);
  });
  await new Promise<void>(resolveListen => server!.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as { port: number }).port;
}

async function runHook(
  payloadText: string,
  options: {
    policy?: unknown;
    status?: number;
    startServer?: boolean;
    endStdin?: boolean;
    exitTimeoutMs?: number;
    transcriptPath?: 'missing' | 'hostile';
    trackTranscriptAccess?: boolean;
    response?: unknown;
    authKind?: 'host' | 'capability';
    signResponse?: boolean;
    responseKey?: string;
    responseMode?: 'normal' | 'oversized-never-ending' | 'partial-never-ending';
    writeHostProof?: boolean;
    relayPort?: number;
    policyOnlyClaim?: boolean;
  } = {},
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  transcriptAccessed: boolean;
}> {
  dir = mkdtempSync(join(tmpdir(), 'botmux-native-subagent-hook-'));
  const relay = join(dir, 'relay');
  mkdirSync(relay, { mode: 0o700 });
  const port = options.startServer === false
    ? 9
    : await listen(options);
  ensureManagedOriginAttestationDirectory(dir, 'session-native', CHANNEL_ID);
  replaceManagedOriginCapabilityFile(
    managedOriginCapabilityPath(dir, 'session-native', CHANNEL_ID),
    JSON.stringify({
      sessionId: 'session-native',
      channelId: CHANNEL_ID,
      ...(!options.policyOnlyClaim ? { capability: CAPABILITY } : {}),
      policyCapability: POLICY_CAPABILITY,
      larkAppId: APP_ID,
      bootInstanceId: BOOT_ID,
      ...(!options.policyOnlyClaim ? { turnId: 'turn-1', dispatchAttempt: 1 } : {}),
      ipcPort: port,
    }),
  );
  writeFileSync(join(relay, '.botmux-origin-capability.json'), JSON.stringify({
    token: CAPABILITY,
    policyCapability: POLICY_CAPABILITY,
    turnId: 'turn-1',
    dispatchAttempt: 1,
    ipcPort: options.relayPort ?? port,
  }), { mode: 0o600 });
  if (options.authKind === 'host') {
    mkdirSync(join(dir, '.botmux'), { mode: 0o700 });
    writeFileSync(join(dir, '.botmux', '.dashboard-secret'), HOST_SECRET, { mode: 0o600 });
    const descriptorDir = join(dir, 'dashboard-daemons');
    mkdirSync(descriptorDir, { mode: 0o700 });
    writeFileSync(join(descriptorDir, `${APP_ID}.json`), JSON.stringify({
      larkAppId: APP_ID, ipcPort: port, bootInstanceId: BOOT_ID, lastHeartbeat: Date.now(),
    }), { mode: 0o600 });
  }
  const parsed = (() => { try { return JSON.parse(payloadText); } catch { return null; } })();
  let transcript: string | undefined;
  if (parsed && typeof parsed === 'object' && options.transcriptPath) {
    transcript = join(dir, `${options.transcriptPath}-rollout.jsonl`);
    if (options.transcriptPath === 'hostile') {
      writeFileSync(transcript, JSON.stringify({
        type: 'turn_context',
        payload: { model: 'attacker-model', reasoning_effort: 'minimal' },
      }));
    }
    parsed.transcript_path = transcript;
    payloadText = JSON.stringify(parsed);
  }

  const accessMarker = join(dir, 'transcript-was-accessed');
  const childOptions = {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: dir,
      SESSION_DATA_DIR: dir,
      BOTMUX_SESSION_ID: 'session-native',
      BOTMUX_LARK_APP_ID: APP_ID,
      BOTMUX_DAEMON_IPC_PORT: String(port),
      ...(options.authKind === 'host' ? {} : { BOTMUX_SEND_RELAY: relay }),
      ...(options.authKind === 'host' ? {} : { BOTMUX_ORIGIN_CHANNEL_ID: CHANNEL_ID }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  } as const;
  const child = options.trackTranscriptAccess && transcript
    ? spawnTsEvalWithRepoImports(`
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const originalOpenSync = fs.openSync;
        const originalReadFileSync = fs.readFileSync;
        const originalStatSync = fs.statSync;
        const markTranscriptAccess = path => {
          if (String(path) === ${JSON.stringify(transcript)}) {
            fs.writeFileSync(${JSON.stringify(accessMarker)}, 'accessed');
          }
        };
        fs.openSync = function (path, ...args) {
          markTranscriptAccess(path);
          return originalOpenSync.call(this, path, ...args);
        };
        fs.readFileSync = function (path, ...args) {
          markTranscriptAccess(path);
          return originalReadFileSync.call(this, path, ...args);
        };
        fs.statSync = function (path, ...args) {
          markTranscriptAccess(path);
          return originalStatSync.call(this, path, ...args);
        };
        syncBuiltinESMExports();
        process.argv = [process.execPath, ${JSON.stringify(CLI)}, 'native-subagent-runtime-hook'];
        await import(${JSON.stringify(pathToFileURL(CLI).href)});
      `, childOptions)
    : spawnTsScript(CLI, ['native-subagent-runtime-hook'], childOptions);
  child.stdin!.on('error', () => { /* hook may close oversized/slow input early */ });
  if (options.endStdin === false) child.stdin!.write(payloadText);
  else child.stdin!.end(payloadText);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  const status = await new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.exitTimeoutMs ?? 5_000);
    child.once('exit', code => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return {
    status, stdout, stderr, timedOut,
    transcriptAccessed: existsSync(accessMarker),
  };
}

const spawnPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'spawn_agent',
  model: 'payload-model-fallback',
  tool_input: { task_name: 'child', role: 'worker', fork_turns: 'all' },
};

describe('native-subagent-runtime-hook CLI', () => {
  afterEach(() => { capturedRequests = []; });
  it('is a no-op for unrelated tools without contacting the policy server', async () => {
    const result = await runHook(JSON.stringify({ ...spawnPayload, tool_name: 'Bash' }));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(capturedRequests).toHaveLength(0);
  });

  it('is a no-op for malformed or oversized stdin', async () => {
    for (const input of [
      '{bad json',
      JSON.stringify({ ...spawnPayload, padding: 'secret-never-echo'.repeat(100_000) }),
    ]) {
      const result = await runHook(input, { startServer: false });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeLessThanOrEqual(1024);
      expect(result.stderr).not.toContain('secret-never-echo');
    }
  });

  it('stops reading oversized stdin without waiting for EOF', async () => {
    const result = await runHook('x'.repeat(256 * 1024 + 1), {
      startServer: false,
      endStdin: false,
      exitTimeoutMs: 3_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin exceeded size limit');
  });

  it('stops reading slow partial stdin at an internal deadline', async () => {
    const result = await runHook('{"hook_event_name":', {
      startServer: false,
      endStdin: false,
      exitTimeoutMs: 3_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin read timed out');
  });

  it('fails open for daemon failure, invalid response policy, and pass-through policy', async () => {
    const cases = [
      { options: { startServer: false }, diagnostic: undefined },
      { options: { status: 503 }, diagnostic: undefined },
      {
        options: { policy: { model: { mode: 'custom', value: '' } } },
        diagnostic: 'daemon returned invalid policy; allowing spawn',
      },
      {
        options: { response: { ok: true, invalidPolicy: true } },
        diagnostic: 'daemon rejected invalid stored policy; allowing spawn',
      },
      { options: { policy: undefined }, diagnostic: undefined },
    ];
    for (const { options, diagnostic } of cases) {
      const result = await runHook(JSON.stringify(spawnPayload), options);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeLessThanOrEqual(1024);
      if (diagnostic) expect(result.stderr).toContain(diagnostic);
    }
  });

  it('never sends the raw capability and rejects a stale listener forged response', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'custom', value: 'forged-model' } },
      writeHostProof: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('response authentication failed');
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body).toBe('{}');
    expect(JSON.stringify(capturedRequests[0])).not.toContain(CAPABILITY);
  });

  it('ignores a forged writable relay port and uses the protected host claim', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'custom', value: 'protected-model' } },
      relayPort: 9,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toMatchObject({
      model_provider: 'trae',
      model: 'protected-model',
    });
  });

  it('rewrites spawn input from a policy-only per-channel claim after terminal', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'custom', value: 'post-terminal-model' } },
      policyOnlyClaim: true,
      relayPort: 9,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toMatchObject({
      model_provider: 'trae',
      model: 'post-terminal-model',
    });
    expect(JSON.parse(readFileSync(
      managedOriginCapabilityPath(dir!, 'session-native', CHANNEL_ID),
      'utf8',
    ))).toEqual({
      sessionId: 'session-native',
      channelId: CHANNEL_ID,
      policyCapability: POLICY_CAPABILITY,
      larkAppId: APP_ID,
      bootInstanceId: BOOT_ID,
      ipcPort: expect.any(Number),
    });
  });

  it('rejects a forged response even when the stale listener knows the capability', async () => {
    const forged = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'custom', value: 'forged-model' } },
      responseKey: POLICY_CAPABILITY,
      signResponse: true,
      writeHostProof: false,
    });
    expect(forged.stdout).toBe('');
    expect(forged.stderr).toContain('response authentication failed');
  });

  it('rejects the wrong host response key and accepts the current host daemon', async () => {
    const forgedHost = await runHook(JSON.stringify(spawnPayload), {
      authKind: 'host',
      policy: { model: { mode: 'custom', value: 'forged-host-model' } },
      responseKey: 'wrong-host-secret',
    });
    expect(forgedHost.stdout).toBe('');
    expect(forgedHost.stderr).toContain('response authentication failed');

    const host = await runHook(JSON.stringify(spawnPayload), {
      authKind: 'host',
      policy: { model: { mode: 'custom', value: 'host-model' } },
    });
    expect(JSON.parse(host.stdout).hookSpecificOutput.updatedInput).toMatchObject({
      model_provider: 'trae',
      model: 'host-model',
    });
  });

  it('fails open for an unsigned 429 from a forged protected listener', async () => {
    const overloaded = await runHook(JSON.stringify(spawnPayload), {
      status: 429,
      response: { ok: false, error: 'native_runtime_overloaded' },
      signResponse: false,
      writeHostProof: false,
    });

    expect(overloaded.status).toBe(0);
    expect(overloaded.stdout).toBe('');
    expect(overloaded.stderr).toContain('response authentication failed');
  });

  it('fails open for a forged 429 signed with the child-readable policy capability', async () => {
    const overloaded = await runHook(JSON.stringify(spawnPayload), {
      status: 429,
      response: { ok: false, error: 'native_runtime_overloaded' },
      responseKey: POLICY_CAPABILITY,
      signResponse: true,
      writeHostProof: false,
    });

    expect(overloaded.status).toBe(0);
    expect(overloaded.stdout).toBe('');
    expect(overloaded.stderr).toContain('response authentication failed');
  });

  it('fails closed on an authenticated proof-backed overload response from the protected destination', async () => {
    const overloaded = await runHook(JSON.stringify(spawnPayload), {
      status: 429,
      response: { ok: false, error: 'native_runtime_overloaded' },
    });

    expect(overloaded.status).toBe(0);
    expect(JSON.parse(overloaded.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Native subagent runtime policy is temporarily overloaded; retry spawn_agent',
      },
    });
    expect(overloaded.stderr).toContain('policy service overloaded; denying spawn');
  });

  it('fails closed on an authenticated host-HMAC overload response', async () => {
    const overloaded = await runHook(JSON.stringify(spawnPayload), {
      authKind: 'host',
      status: 429,
      response: { ok: false, error: 'native_runtime_overloaded' },
    });

    expect(overloaded.status).toBe(0);
    expect(JSON.parse(overloaded.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Native subagent runtime policy is temporarily overloaded; retry spawn_agent',
      },
    });
    expect(overloaded.stderr).toContain('policy service overloaded; denying spawn');
  });

  it('cancels oversized and timed-out never-ending response streams', async () => {
    const oversized = await runHook(JSON.stringify(spawnPayload), {
      responseMode: 'oversized-never-ending',
      exitTimeoutMs: 6_000,
    });
    expect(oversized.timedOut).toBe(false);
    expect(oversized.stdout).toBe('');

    const partial = await runHook(JSON.stringify(spawnPayload), {
      responseMode: 'partial-never-ending',
      exitTimeoutMs: 6_000,
    });
    expect(partial.timedOut).toBe(false);
    expect(partial.stdout).toBe('');
  }, 12_000);

  it('is a no-op when the policy passes both runtime dimensions through', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), { policy: undefined });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each(['missing', 'hostile'] as const)(
    'applies custom runtime without accessing a %s transcript path or trusting payload runtime fields',
    async transcriptPath => {
      const result = await runHook(JSON.stringify({
        ...spawnPayload,
        model: 'attacker-payload-model',
        reasoning_effort: 'minimal',
        effort: 'low',
      }), {
        policy: {
          model: { mode: 'custom', value: 'policy-model' },
          reasoningEffort: { mode: 'custom', value: 'xhigh' },
        },
        transcriptPath,
        trackTranscriptAccess: true,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.transcriptAccessed).toBe(false);
      expect(result.stdout.endsWith('\n')).toBe(false);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            task_name: 'child', role: 'worker', fork_turns: 'all',
            model_provider: 'trae', model: 'policy-model', reasoning_effort: 'xhigh',
          },
        },
      });
    },
  );
});
