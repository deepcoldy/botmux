/**
 * The crash-diagnostic terminal of an hc session: the shell tmux parks as
 * `bmx-diag-<sid>`, here `bmx-diag-<sid8>` on the session's own core and owned
 * like its CLI terminal (the daemon reclaims it by the same labels). Web
 * clients reach it through per-client `hc attach` processes, as tmux serves its
 * diagnostic session through per-client `tmux attach`.
 */
import { resolve } from 'node:path';
import { hcXdgRestoreArgv, runHcTerminalSync } from '../hc-backend.js';
import { diagnosticShellScript, resolveUserShell, shellCommandArgv, shellKindForPath } from '../tmux-backend.js';
import { hcOwnerLabels, killHcTerminal, type HcTarget } from './cli-ops.js';
import { prepareHcSyncCore, startHcCoreSync } from './sync-rpc.js';
import type { HcRunParams } from './types.js';

const RUN_TIMEOUT_MS = 15_000;
/** The parked crash output is usually longer than one screen. */
const ATTACH_HISTORY_LINES = 3_000;

/** Replace any earlier diagnostic terminal of this session; throws a readable reason. */
export function parkHcDiagnosticTerminal(
  target: HcTarget,
  sessionId: string,
  opts: { cwd: string; cols: number; rows: number; contentPath: string; env?: NodeJS.ProcessEnv },
): void {
  const env = opts.env ?? process.env;
  const core = prepareHcSyncCore(target, env);
  startHcCoreSync(core);
  const stale = killHcTerminal(target, sessionId, { env });
  if (stale.result === 'mismatch') {
    throw new Error(`hc 终端名 ${target.sessionName} 已被${stale.owner ? `会话 ${stale.owner}` : '非 botmux 终端'}占用`);
  }
  if (stale.result === 'unknown') throw new Error(stale.reason);
  const shell = resolveUserShell(env);
  const params: HcRunParams & { name: string } = {
    argv: [
      ...hcXdgRestoreArgv(env),
      ...shellCommandArgv(shell, diagnosticShellScript(shellKindForPath(shell.shell)), [opts.cwd, opts.contentPath, shell.shell]),
    ],
    name: target.sessionName,
    cwd: resolve(opts.cwd),
    size: { cols: opts.cols, rows: opts.rows },
    labels: hcOwnerLabels(sessionId),
    no_parent: true,
    no_notify: true,
  };
  const ran = runHcTerminalSync(core, params, RUN_TIMEOUT_MS);
  if (!ran.ok) throw new Error(`hc 诊断终端创建失败：${ran.message}`);
}

/**
 * One web client's `hc attach` to the diagnostic terminal. Run it on a pty:
 * an observer whose stdin is not a terminal spins (herdr-core#180).
 */
export function hcDiagnosticAttachCommand(
  target: HcTarget,
  opts: { observe: boolean; env?: NodeJS.ProcessEnv },
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const core = prepareHcSyncCore(target, opts.env ?? process.env);
  return {
    bin: core.bin,
    args: ['attach', ...(opts.observe ? ['--observe'] : []), '--history', String(ATTACH_HISTORY_LINES), target.sessionName],
    env: core.env,
  };
}
