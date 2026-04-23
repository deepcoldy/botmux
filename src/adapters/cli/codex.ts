import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Substring present on every real user-submit line in Codex's session rollout
 *  and absent from session_meta / response_item / other event_msg subtypes. */
const USER_SUBMIT_MARKER = '"type":"event_msg","payload":{"type":"user_message"';

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function deltaHasUserSubmit(path: string, fromByte: number): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8').includes(USER_SUBMIT_MARKER);
}

async function waitForUserSubmit(path: string, baseByte: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deltaHasUserSubmit(path, baseByte)) return true;
    await delay(100);
  }
  return false;
}

/** Enumerate rollout-*.jsonl files under ~/.codex/sessions newer than spawnStart. */
function enumerateRollouts(root: string, sinceMs: number): string[] {
  if (!existsSync(root)) return [];
  const results: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && depth < 3) {
        walk(p, depth + 1);
      } else if (
        depth === 3 &&
        st.isFile() &&
        name.startsWith('rollout-') &&
        name.endsWith('.jsonl') &&
        st.mtimeMs >= sinceMs
      ) {
        results.push({ path: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  return results.map(r => r.path);
}

/** Read the first JSONL line of a rollout file (session_meta) and check its cwd. */
function rolloutMatchesCwd(path: string, cwd: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      const text = buf.slice(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      const line = nl > 0 ? text.slice(0, nl) : text;
      return line.includes(`"cwd":"${cwd}"`);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Resolve the rollout JSONL path for a freshly-spawned Codex session. Codex
 * manages its own session id, so the file name contains a uuid we don't know
 * ahead of time. Poll ~/.codex/sessions/YYYY/MM/DD for the newest
 * `rollout-<ts>-<uuid>.jsonl` whose first-line session_meta references our cwd.
 * `spawnStartMs` filters out pre-existing files from unrelated sessions.
 */
export async function resolveCodexRolloutPath(
  cwd: string,
  spawnStartMs: number,
  timeoutMs = 10_000,
): Promise<string | null> {
  const root = join(homedir(), '.codex', 'sessions');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const path of enumerateRollouts(root, spawnStartMs)) {
      if (rolloutMatchesCwd(path, cwd)) return path;
    }
    await delay(200);
  }
  return null;
}

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs() {
      // Codex manages its own session IDs internally — we cannot pass ours.
      // Resume is not supported; daemon always starts a fresh Codex session.
      return [
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
      ];
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Codex's TUI has a paste-grouping heuristic: a rapid burst of chars
      // followed quickly by Enter can absorb the Enter as "still pasting",
      // leaving the text stuck in the input box (same failure mode Claude Code
      // has). The fixed 200ms delay is not enough under slow disk / big paste /
      // MCP init. Tail the session rollout JSONL: every real user submit
      // appends a line with `"type":"event_msg","payload":{"type":"user_message"`.
      // If it doesn't show up, re-send Enter up to 3 times, then surface to
      // the user instead of silently dropping.
      const sendEnter = () => {
        if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
        else pty.write('\r');
      };

      const baseByte = pty.codexRolloutPath ? currentFileSize(pty.codexRolloutPath) : 0;

      if (pty.sendText) {
        pty.sendText(content);
      } else {
        pty.write(content);
      }
      await delay(200);
      sendEnter();

      if (!pty.codexRolloutPath) return;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForUserSubmit(pty.codexRolloutPath, baseByte, 800)) return;
        sendEnter();
      }
      if (await waitForUserSubmit(pty.codexRolloutPath, baseByte, 800)) return;
      return { submitted: false };
    },

    completionPattern: undefined,
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
