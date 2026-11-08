/**
 * Trigger-user auth OFF must leave governed tools exactly as they are without
 * the policy — including in a session that once ran with it ON.
 *
 * The identity wrappers live in the session's identity bin dir, which is also
 * the lark-cli binding's bin dir. Every bound session (the default since the
 * binding shipped) puts that dir first on PATH whether or not trigger-user auth
 * is on. A wrapper left behind there after the policy is turned off keeps
 * intercepting the tool while the daemon publishes nothing for it, so every
 * call is refused (exit 77) for the life of the session. These cases drive the
 * real worker-side setup (`prepareTriggerUserCliEnv` + `prepareLarkToolEnv`)
 * across two spawns of one session and resolve the tool through PATH the way
 * the agent's shell does.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareTriggerUserCliEnv, sessionIdentityBinDir } from '../src/core/cli-identity.js';
import { prepareLarkToolEnv } from '../src/core/lark-tool-binding.js';
import type { TriggerUserAuthConfig, TriggerUserAuthTool } from '../src/services/trigger-user-auth.js';

const SESSION = 'policy-off-session';
let root: string;
let dataDir: string;
let realBin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-policy-off-'));
  dataDir = join(root, 'data');
  realBin = join(root, 'real-bin');
  mkdirSync(dataDir);
  mkdirSync(realBin);
  for (const tool of ['bytedcli', 'codebase', 'lark-cli']) {
    writeFileSync(join(realBin, tool), `#!/bin/sh\necho "real ${tool} $*"\n`, { mode: 0o755 });
  }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function policy(tools: TriggerUserAuthTool[]): TriggerUserAuthConfig {
  return { enabled: true, tools, fallback: 'bot-identity', credentialSource: 'local' };
}

/** One worker spawn of the session: the same two calls, in the same order, as
 *  the worker's PTY path (identity wrappers first, then the lark binding). */
function spawnSession(triggerUserAuth: TriggerUserAuthConfig | undefined, boundLark = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${realBin}:/usr/bin:/bin`, HOME: root };
  const identityPolicy = boundLark && triggerUserAuth
    ? { ...triggerUserAuth, tools: triggerUserAuth.tools.filter(tool => tool !== 'lark-cli') }
    : triggerUserAuth;
  prepareTriggerUserCliEnv(env, dataDir, SESSION, identityPolicy, () => {}, 'single');
  if (boundLark) {
    prepareLarkToolEnv({ env, dataDir, sessionId: SESSION, appId: 'cli_policyoff', runner: { command: '/bin/true', args: [] } });
  }
  return env;
}

function run(env: NodeJS.ProcessEnv, tool: string): { resolved: string; status: number | null; output: string } {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${tool}; ${tool} status`], { env, encoding: 'utf8' });
  const [resolved = '', ...rest] = result.stdout.split('\n');
  return { resolved, status: result.status, output: rest.join('\n') + result.stderr };
}

describe('trigger-user auth turned off', () => {
  it('a session that spawned under the policy runs the real bytedcli once it respawns with the policy off', () => {
    const before = run(spawnSession(policy(['lark-cli', 'bytedcli'])), 'bytedcli');
    expect(before.resolved).toBe(join(sessionIdentityBinDir(dataDir, SESSION), 'bytedcli'));
    expect(before.status).toBe(77);

    const env = spawnSession(undefined);
    const after = run(env, 'bytedcli');
    expect(after.resolved).toBe(join(realBin, 'bytedcli'));
    expect(after.status).toBe(0);
    expect(after.output).toContain('real bytedcli status');
    expect(run(env, 'codebase').resolved).toBe(join(realBin, 'codebase'));
    // The lark-cli binding entry is not a trigger-user wrapper and stays.
    expect(readFileSync(join(sessionIdentityBinDir(dataDir, SESSION), 'lark-cli'), 'utf8'))
      .toContain('# botmux managed lark-cli');
  });

  it('an explicit enabled:false behaves the same as an absent policy', () => {
    spawnSession(policy(['bytedcli']));
    const after = run(spawnSession({ ...policy(['bytedcli']), enabled: false }), 'bytedcli');
    expect(after.resolved).toBe(join(realBin, 'bytedcli'));
    expect(after.status).toBe(0);
  });

  it('dropping bytedcli from the policy releases bytedcli and its codebase companion, not lark-cli', () => {
    spawnSession(policy(['lark-cli', 'bytedcli']), false);
    const env = spawnSession(policy(['lark-cli']), false);
    expect(run(env, 'bytedcli').resolved).toBe(join(realBin, 'bytedcli'));
    expect(run(env, 'codebase').resolved).toBe(join(realBin, 'codebase'));
    const lark = run(env, 'lark-cli');
    expect(lark.resolved).toBe(join(sessionIdentityBinDir(dataDir, SESSION), 'lark-cli'));
    expect(lark.status).toBe(77);
  });

  it('never removes a file in the bin dir that botmux did not generate', () => {
    const binDir = sessionIdentityBinDir(dataDir, SESSION);
    mkdirSync(binDir, { recursive: true });
    const own = '#!/bin/sh\n# operator-provided bytedcli shim\necho "operator shim"\n';
    writeFileSync(join(binDir, 'bytedcli'), own, { mode: 0o755 });
    spawnSession(undefined);
    expect(readFileSync(join(binDir, 'bytedcli'), 'utf8')).toBe(own);
  });

  it('a session that never enabled the policy gets no identity wrapper at all', () => {
    const env = spawnSession(undefined);
    expect(run(env, 'bytedcli').resolved).toBe(join(realBin, 'bytedcli'));
    const binDir = sessionIdentityBinDir(dataDir, SESSION);
    expect(readdirSync(binDir).filter(name => ['bytedcli', 'codebase'].includes(name))).toEqual([]);
  });
});
