// ─── Claude Code folder-trust pre-acceptance ─────────────────────────────────
//
// A freshly spawned `claude` in a workingDir that has never been trusted blocks
// on the interactive "Do you trust the files in this folder?" dialog. botmux
// can't answer it — it then mistypes the user's first message into the dialog
// and the session breaks (surfaced as `tmux send-keys … failed`). There is no
// CLI flag to skip it (Claude only auto-skips trust in non-interactive `-p` /
// non-TTY mode, which botmux is not), so we pre-seed the acceptance.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';
import { logger } from './logger.js';

/** Pre-accept Claude Code's per-project folder-trust dialog for `workingDir`.
 *  Claude keys trust off realpath(cwd) (its getcwd(3) is already realpath'd),
 *  so seed that path. Merge-safe + best-effort: only ADDS the flag, never
 *  clobbers other keys; any failure is swallowed so it can't block spawn. */
export function ensureClaudeFolderTrust(workingDir: string, stateJsonPath: string = join(homedir(), '.claude.json')): void {
  try {
    const configPath = stateJsonPath;
    let canonical: string;
    try { canonical = realpathSync(workingDir); } catch { canonical = workingDir; }

    let data: any = {};
    if (existsSync(configPath)) {
      try { data = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return; }
    }
    if (!data || typeof data !== 'object') return;
    if (!data.projects || typeof data.projects !== 'object') data.projects = {};

    const entry = data.projects[canonical] && typeof data.projects[canonical] === 'object'
      ? data.projects[canonical]
      : (data.projects[canonical] = {});
    if (entry.hasTrustDialogAccepted === true) return; // already trusted — skip write

    entry.hasTrustDialogAccepted = true;
    // 原子写：~/.claude.json 是 Claude Code 的热状态文件，所有并发 claude
    // 实例都在读写，裸写半截会弄坏它们的状态。
    atomicWriteFileSync(configPath, JSON.stringify(data, null, 2));
    logger.info(`[claude-trust] Pre-accepted folder trust for ${canonical}`);
  } catch (err) {
    logger.debug(`[claude-trust] seed failed (ignored): ${err}`);
  }
}
