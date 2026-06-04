/**
 * Reader for TRAE CLI (traex / traecli) per-session rollout JSONL.
 *
 * TRAE is a Codex-family CLI:
 *   - Rollout content format is byte-identical to Codex (response_item with
 *     role=user / role=assistant+phase=final_answer message blocks).
 *   - Directory layout differs: sessions live under
 *     ~/.trae/cli/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *     (note the extra `cli/` level vs Codex's ~/.codex/sessions/...).
 *
 * This module therefore re-exports drainCodexRollout and friends directly,
 * and only provides TRAE-specific path finders (by pid / by session id).
 */
import { existsSync, statSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import {
  drainCodexRollout,
  splitCodexEventsByCutoff,
  extractLastCodexTurn,
  type CodexBridgeEvent,
  type CodexDrainResult,
  codexSessionIdFromRolloutPath,
} from './codex-transcript.js';
import { traeSessionsRoot } from './traex-paths.js';

export { drainCodexRollout as drainTraexRollout };
export { splitCodexEventsByCutoff as splitTraexEventsByCutoff };
export { extractLastCodexTurn as extractLastTraexTurn };
export type { CodexBridgeEvent as TraexBridgeEvent, CodexDrainResult as TraexDrainResult };

const IS_LINUX = platform() === 'linux';

function matchTraexRolloutPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  // Accept both the default layout (~/.trae/cli/sessions/...) and any
  // TRAE_HOME override the user may have configured.
  if (!target.includes('/sessions/') && !target.includes('.trae')) {
    // Fast reject: the path has neither the sessions subdir nor the default
    // TRAE home marker. Avoid false positives against Codex rollouts which
    // share the same rollout-*.jsonl filename shape.
    if (!target.includes('/cli/sessions/')) return undefined;
  }
  const sid = codexSessionIdFromRolloutPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

/** Find the rollout file an externally-running TRAE process has open.
 *  Same /proc/<pid>/fd strategy as findCodexRolloutByPid, but with a
 *  TRAE-specific path matcher so we never bind to a sibling Codex pane. */
export function findTraexRolloutByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const hit = matchTraexRolloutPath(target);
        if (hit) return hit;
      }
      return undefined;
    }
  }
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const target = line.slice(1);
    const hit = matchTraexRolloutPath(target);
    if (hit) return hit;
  }
  return undefined;
}

/** Locate the rollout file for a given TRAE session UUID. Filename shape is
 *  identical to Codex: `rollout-<ts>-<sid>.jsonl`, so a suffix match over the
 *  TRAE sessions tree is unambiguous. */
export function findTraexRolloutBySessionId(cliSessionId: string): string | undefined {
  const sessionsRoot = traeSessionsRoot();
  if (!cliSessionId || !existsSync(sessionsRoot)) return undefined;
  const suffix = `-${cliSessionId}.jsonl`;
  const stack: string[] = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return undefined;
}
