import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter } from './types.js';
import { delay } from '../../utils/timing.js';
import { readZcodeModelChoices } from '../../services/zcode-models.js';
import { readZcodeSubmissionReceipt, readZcodeSubmissionReceiptsAfter, zcodeInputSha256, zcodeNativeSessionExists, zcodeSessionDbPath } from '../../services/zcode-session.js';

const NATIVE_SESSION_ID = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ZCode's own busy footer: `⠹ esc to interrupt` on its own line, immediately
 * left of the context badge. The braille glyph is the animated spinner frame
 * (80ms, 10 frames), so it can never be part of the anchor; the words are
 * static for the whole run. Verified against the live TUI (0.16.9).
 */
const ZCODE_BUSY_FOOTER = /^\s*(?:[\u2800-\u28ff]\s+)?esc to interrupt\b/m;

/**
 * Idle composer placeholder. ZCode swaps its placeholder by busy state:
 * `Type a prompt` (en) / `输入提示词` (zh) when idle, `Type to queue input` /
 * `输入内容会排队` while a turn runs. Anchoring on the idle wording — never on
 * the frame border, which is identical in both states — is what makes this a
 * positive ready signal instead of a "no busy footer" guess.
 */
const ZCODE_IDLE_PLACEHOLDER = /(?:^|[\n\r])[^\S\n]*[│|]?\s*(?:Type a prompt|输入提示词)/;

/** Busy-state placeholder — the same composer, queued mode. Exported so the
 *  adapter test can pin it: a wording change upstream must fail loudly instead
 *  of silently degrading readyPattern to "anything that is not the busy footer".
 */
export const ZCODE_BUSY_PLACEHOLDER = /(?:Type to queue input|输入内容会排队)/;

/**
 * The queue panel ZCode draws when a submit lands during an active turn:
 * "Submitted after the next tool call." Measured behaviour on 0.16.9 is that
 * such an item is NOT drained when the turn ends (its session_input row stays
 * `admitted`, no user message is written) — see the type-ahead note below.
 * Exported so the test can assert the panel is never mistaken for readiness.
 */
export const ZCODE_QUEUE_PANEL = /(?:Submitted after the next tool call|队列（|下一次工具调用后提交)/;

/** Native ZCode TUI. Model configuration is prepared per session by the worker;
 * buildArgs is pure and never changes the CLI's shared defaults. */
export function createZcodeAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'zcode';
  let cachedBin: string | undefined;
  let botmuxSessionId: string | undefined;
  let dataDir = process.env.SESSION_DATA_DIR || join(homedir(), '.botmux', 'data');
  return {
    id: 'zcode',
    get resolvedBin() { return cachedBin ??= resolveCommand(rawBin); },
    authPaths: ['~/.zcode'],
    skillsDir: '~/.zcode/skills',
    altScreen: true,
    resumeRequiresCliSessionId: true,
    busyPattern: ZCODE_BUSY_FOOTER,
    readyPattern: ZCODE_IDLE_PLACEHOLDER,
    /*
     * supportsTypeAhead is deliberately NOT set. Measured on 0.16.9: a submit
     * typed during an active turn is parked in ZCode's own queue panel
     * ("Submitted after the next tool call"), and that parked item is NOT
     * drained when the turn ends — it disappears from the panel while the
     * session_input row stays `admitted`, i.e. the user's instruction is
     * silently dropped. Two independent runs reproduced it. So ZCode must be
     * driven one message per genuine idle edge.
     */
    /*
     * One message per flush. Without this the worker writes every buffered
     * Lark message back-to-back into the PTY after a single idle, which is
     * exactly how 2026-10-18 22:46 lost two user messages: only the first
     * started a turn, the other two became parked queue items.
     */
    postTerminalPromptFence: true,
    // Single Ctrl+C quits ZCode entirely, even mid-turn (verified 0.16.9);
    // Escape is its interrupt key, as the busy footer advertises.
    interruptKey: 'esc',
    // A mid-turn message cannot be steered or parked usefully here, so it
    // replaces the running turn instead of waiting behind it. This is the
    // "stop renting that GPU now" case: the user's instruction must take effect
    // immediately, not after the turn they are trying to abort finishes.
    preemptsOnNewMessage: true,
    buildArgs(opts) {
      botmuxSessionId = opts.shellSubprocessEnv?.BOTMUX_SESSION_ID ?? opts.sessionId;
      dataDir = process.env.SESSION_DATA_DIR || dataDir;
      const args: string[] = [];
      if (!opts.disableCliBypass) args.push('--mode', 'yolo');
      if (opts.resume && opts.resumeSessionId) {
        if (!NATIVE_SESSION_ID.test(opts.resumeSessionId)) throw new Error('Invalid ZCode native resume id');
        args.push('--resume', opts.resumeSessionId);
      }
      return args;
    },
    buildResumeCommand({ cliSessionId }) {
      // Informational command for "open this session in my own terminal":
      // best effort, like every other adapter. Exactness is enforced where it
      // matters — buildArgs/checkResumeTargetExists reject a non-native id.
      return cliSessionId ? `zcode --resume ${cliSessionId}` : null;
    },
    checkResumeTargetExists({ cliSessionId, stateDbPath }) {
      return !!cliSessionId && NATIVE_SESSION_ID.test(cliSessionId)
        && zcodeNativeSessionExists(cliSessionId, stateDbPath ?? zcodeSessionDbPath());
    },
    async writeInput(pty, content, context) {
      const submittedAt = Date.now();
      const sha256 = zcodeInputSha256(content);
      const recheck = () => {
        if (!botmuxSessionId) return { submitted: false };
        const receipt = readZcodeSubmissionReceipt(botmuxSessionId, sha256, { dataDir, afterMs: submittedAt });
        if (receipt) return { submitted: true, cliSessionId: receipt.cliSessionId, ownershipProven: true };
        // The TUI may normalise what it submits (whitespace folding, prefix
        // stripping). The write epoch is the ownership proof; the digest is only
        // the fast path. Accept a normalised submit when the window is
        // unambiguous — exactly one receipt landed since this write began.
        const after = readZcodeSubmissionReceiptsAfter(botmuxSessionId, { dataDir, afterMs: submittedAt });
        const distinct = [...new Set(after.map(entry => `${entry.cliSessionId}:${entry.submittedAt}`))];
        return distinct.length === 1
          ? { submitted: true, cliSessionId: after[0]!.cliSessionId }
          : { submitted: false };
      };
      try {
        if (pty.pasteText && pty.sendSpecialKeys) {
          pty.pasteText(content);
          await delay(250);
          if (pty.sendSpecialKeys('Enter') === false) return { submitted: false, recheck };
        } else {
          if (pty.write(content) === false) return { submitted: false, recheck };
          await delay(500);
          if (pty.write('\r') === false) return { submitted: false, recheck };
        }
        // Observe native UserPromptSubmit; never replay a paste merely because
        // confirmation is slow. The worker's delayed recheck handles late receipts.
        for (let i = 0; i < 25; i++) {
          const result = recheck();
          if (result.submitted) return result;
          await delay(200);
        }
        return { submitted: false, recheck };
      } catch { return { submitted: false, recheck }; }
    },
    // NOT a model-input channel: nothing in the repo reads `systemHints`
    // (`buildBotmuxShellHints` in shared-hints.ts is what actually reaches the
    // model). The interim-report instruction lives there under
    // `ai.zcode.progress_report`, and the attachment guidance rides
    // `ai.routing.usage_attachments`. Text left here would look authoritative
    // and silently never arrive.
    systemHints: [],
    // `undefined` means "no curated list" (the static CLI_MODEL_CHOICES
    // contract); content comes from the live personal provider config.
    get modelChoices() { try { const choices = readZcodeModelChoices(); return choices.length ? choices : undefined; } catch { return undefined; } },
    async detectModels() { try { return readZcodeModelChoices(); } catch { return null; } },
    defaultPassthroughCommands: ['/model', '/effort', '/compact', '/clear'],
  };
}
export const create = createZcodeAdapter;
