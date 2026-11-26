import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HcClient, isHcError } from '../adapters/backend/hc/client.js';
import { isHcTerminalOwnedBy, type HcTarget } from '../adapters/backend/hc/cli-ops.js';
import { hcControlEnv, hcCorePaths, hcRuntimeError } from '../adapters/backend/hc/core.js';
import type { HcTerminalRecord } from '../adapters/backend/hc/types.js';
import { probeHcAvailability } from '../setup/ensure-hc.js';

const LOOKUP_TIMEOUT_MS = 5_000;
/**
 * hc creates its state dir before starting a core for a client that found
 * none, and a core's serve does so before binding: a state dir that cannot
 * exist leaves the attach able only to connect.
 */
const ATTACH_STATE_HOME = '/dev/null/botmux-hc-attach';

export type HcTerminalLookup =
  | { state: 'found'; record: HcTerminalRecord }
  | { state: 'missing' }
  /** Nothing listens on the socket. */
  | { state: 'absent'; reason: string }
  | { state: 'unknown'; reason: string };

export interface ManagedHcAttachDeps {
  /** The invoking process's env (never a CLI child env); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  lookup?: (socket: string, name: string) => Promise<HcTerminalLookup>;
  attach?: (bin: string, address: string, env: NodeJS.ProcessEnv) => { status: number | null; error?: Error };
}

export type ManagedHcAttachPlan =
  | { ok: true; bin: string; address: string; env: NodeJS.ProcessEnv; target: HcTarget; sessionId: string }
  | { ok: false; message: string };

export type ManagedHcAttachResult =
  | { ok: true }
  | { ok: false; message: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `terminal.get` over a direct connection. Unlike every hc CLI command, a
 * direct connection never starts a core: a core started from a user's terminal
 * would copy that terminal's env into every botmux program it later runs.
 */
export async function lookupHcTerminal(socket: string, name: string): Promise<HcTerminalLookup> {
  let client: HcClient;
  try {
    client = await HcClient.connect(socket, { timeoutMs: LOOKUP_TIMEOUT_MS });
  } catch (err) {
    return isHcError(err, 'unreachable')
      ? { state: 'absent', reason: errorText(err) }
      : { state: 'unknown', reason: errorText(err) };
  }
  try {
    const record = await client.call<HcTerminalRecord>('terminal.get', { terminal: name }, { timeoutMs: LOOKUP_TIMEOUT_MS });
    return { state: 'found', record };
  } catch (err) {
    if (isHcError(err, 'rpc') && err.kind === 'not_found') return { state: 'missing' };
    return { state: 'unknown', reason: errorText(err) };
  } finally {
    client.close();
  }
}

/**
 * Resolve the live terminal `target.sessionName` names on its frozen core and
 * prove by its labels that it is `sessionId`'s. The attach uses its address,
 * which is stable for the lifetime of the core's state.
 */
export async function prepareManagedHcAttach(
  target: HcTarget,
  sessionId: string,
  deps: ManagedHcAttachDeps = {},
): Promise<ManagedHcAttachPlan> {
  const env = deps.env ?? process.env;
  const name = target.sessionName;
  if (!sessionId) return { ok: false, message: `拒绝连接 hc 终端 ${name}：缺少完整的会话 id` };
  const availability = probeHcAvailability({ env });
  if (!availability.ok) return { ok: false, message: `拒绝连接 hc 终端 ${name}：${availability.reason}` };
  let paths: ReturnType<typeof hcCorePaths>;
  try {
    paths = hcCorePaths(env, { core: target });
  } catch (err) {
    return { ok: false, message: `拒绝连接 hc 终端 ${name}：${errorText(err)}` };
  }
  const runtimeError = hcRuntimeError(paths);
  if (runtimeError) return { ok: false, message: `拒绝连接 hc 终端 ${name}：${runtimeError}` };

  const found = await (deps.lookup ?? lookupHcTerminal)(paths.socket, name);
  if (found.state === 'missing') return { ok: false, message: `hc 终端 ${name} 已不存在` };
  if (found.state === 'absent') {
    return { ok: false, message: `botmux 的 hc core（${paths.socket}）没有在运行，attach 不会替它启动：${found.reason}` };
  }
  if (found.state === 'unknown') return { ok: false, message: `拒绝连接 hc 终端 ${name}：${found.reason}` };
  const { record } = found;
  if (typeof record?.address !== 'string' || record.address.includes('/') || record.name !== name) {
    return { ok: false, message: `拒绝连接 hc 终端 ${name}：terminal.get 返回了无法识别的记录` };
  }
  if (!isHcTerminalOwnedBy(record.labels, sessionId)) {
    return { ok: false, message: `拒绝连接 hc 终端 ${name}：它的 botmux 所有权标签不属于这个会话` };
  }
  if (record.state !== 'live') return { ok: false, message: `hc 终端 ${name} 已结束` };
  // The core can stop between this lookup and the attach, which waits on display facts before connecting.
  const attachEnv = { ...hcControlEnv(env, paths), XDG_STATE_HOME: ATTACH_STATE_HOME };
  return { ok: true, bin: availability.bin, address: record.address, env: attachEnv, target, sessionId };
}

/** Hand this terminal to `hc attach <address>`; hc's detach key is Ctrl+\. */
export async function runManagedHcAttach(
  plan: Extract<ManagedHcAttachPlan, { ok: true }>,
  deps: Pick<ManagedHcAttachDeps, 'attach'> & { platform?: NodeJS.Platform } = {},
): Promise<ManagedHcAttachResult> {
  let pinnedSocket: string | undefined;
  try {
    let env = plan.env;
    if ((deps.platform ?? process.platform) === 'darwin') {
      // Native attach opens a new connection after querying the outer TTY.
      // Pin the socket inode so a restarted core cannot reuse the address in
      // that interval. Keep the alias shorter than botmux.sock for sun_path.
      const alias = join(dirname(plan.target.socket), `a${randomBytes(3).toString('base64url')}.sock`);
      linkSync(plan.target.socket, alias);
      pinnedSocket = alias;
      if (!lstatSync(alias).isSocket()) throw new Error('hc socket 路径被非 socket 文件占用');
      const found = await lookupHcTerminal(alias, plan.address);
      if (found.state !== 'found' || found.record.state !== 'live'
        || found.record.name !== plan.target.sessionName || found.record.address !== plan.address
        || !isHcTerminalOwnedBy(found.record.labels, plan.sessionId)) {
        return { ok: false, message: `hc 终端 ${plan.target.sessionName} 已变化，请重新接入` };
      }
      env = { ...env, HC_SOCKET: alias };
    }
    const attached = deps.attach
      ? deps.attach(plan.bin, plan.address, env)
      : spawnSync(plan.bin, ['attach', plan.address], { stdio: 'inherit', env });
    if (attached.error) throw attached.error;
    if (attached.status !== 0) {
      return { ok: false, message: `hc attach ${plan.address} 退出码 ${attached.status ?? 'unknown'}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `hc attach ${plan.address} 无法执行：${errorText(error)}` };
  } finally {
    if (pinnedSocket) {
      try { rmSync(pinnedSocket, { force: true }); } catch { /* the core no longer uses this name */ }
    }
  }
}
