import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { findKimiSessionForBotmuxSession, isKimiSessionId } from './kimi-session.js';

import { delay } from '../../utils/timing.js';
import { wrapBracketedPaste } from './tui-input.js';

const KIMI_FIRST_WRITE_SETTLE_MS = 250;
const kimiFirstWriteSeen = new WeakSet<PtyHandle>();

export function createKimiAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kimi';
  let cachedBin: string | undefined;
  return {
    id: 'kimi',
    // Kimi's whole data dir: under the oncall sandbox its sessions,
    // session_index.jsonl and config.toml must persist on the host, or every
    // restart starts over and the resume lookup below finds nothing. The
    // binaries next to them stay read-only (sandboxReadonlyPaths, deeper wins).
    authPaths: ['~/.kimi-code'],
    sandboxReadonlyPaths: () => ['~/.kimi-code/bin'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, env, model, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) {
        // Kimi Code's `--yolo` stopped meaning "approve everything": since
        // 0.28 it auto-approves only regular tool calls, and since 2.0 it is
        // "Ask When Needed" (risky actions, questions and plans still stop for
        // a human). `--auto` ("Never Ask") is the approval bypass that
        // disableCliBypass guards; it is present from 0.10.0 on.
        args.push('--auto');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!resume) return args;
      // Kimi resumes only a session it minted itself (`--session <id>`, see
      // kimi-session.ts), so find it by the botmux session id. Never
      // `--continue`: it resumes the most recent session of this working dir,
      // which may be a sibling botmux session's.
      const kimiSessionId = isKimiSessionId(resumeSessionId)
        ? resumeSessionId
        : findKimiSessionForBotmuxSession(sessionId, workingDir, { ...process.env, ...env });
      return kimiSessionId ? [...args, '--session', kimiSessionId] : args;
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      const id = isKimiSessionId(cliSessionId) ? cliSessionId : findKimiSessionForBotmuxSession(sessionId, undefined);
      return id ? `kimi --session ${id}` : null;
    },

    // No session found for this botmux session → the worker starts fresh and
    // says so once, instead of `--session` exiting on "Session … not found".
    resumeFindsOwnSession: true,
    checkResumeTargetExists({ sessionId, cliSessionId, workingDir, env }) {
      if (isKimiSessionId(cliSessionId)) return undefined;
      return findKimiSessionForBotmuxSession(sessionId, workingDir, env ?? process.env) !== undefined;
    },

    async writeInput(pty: PtyHandle, content: string) {
      try {
        if (!kimiFirstWriteSeen.has(pty)) {
          kimiFirstWriteSeen.add(pty);
          await delay(KIMI_FIRST_WRITE_SETTLE_MS);
        }
        if (pty.pasteText && pty.sendSpecialKeys) {
          pty.pasteText(content);
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          const pasted = wrapBracketedPaste(content);
          pty.write(pasted);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return;
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    modelChoices: CLI_MODEL_CHOICES['kimi'],
  };
}
