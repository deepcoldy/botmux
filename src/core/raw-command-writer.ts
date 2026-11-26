import { wrapBracketedPaste } from '../adapters/cli/tui-input.js';

/** Minimal write surface shared by PTY/session backends for literal slash
 * commands. Historical backends return void on success; guarded backends
 * return false when the target pane/process is already unavailable. */
export interface RawCommandWriter {
  submitBracketedPaste?: (text: string) => void | boolean;
  sendBracketedPaste?: (text: string) => void | boolean;
  readonly supportsRawCommandPasteLine?: boolean;
  write(data: string): void | boolean;
  sendText?: (text: string) => void | boolean;
  sendSpecialKeys?: (...keys: string[]) => void | boolean;
  pasteText?: (text: string) => void | boolean;
}

export interface RawCommandWriteOptions {
  coco?: boolean;
  cocoThrottleMs?: number;
  /** Submit the command as a paste followed by a distinct Enter. */
  bracketedPaste?: boolean;
  pasteLine?: boolean;
  pasteSettleMs?: number;
  submitBeatMs?: number;
  delay?: (ms: number) => Promise<void>;
  /** Recheck the owning physical generation before every text/key write. */
  isCurrent?: () => boolean;
}

/** Type one literal input line WITHOUT submitting it.
 *
 * Split out of `writeRawCommandLine` for callers that must re-check the screen
 * between the typed text and the submitting Enter (a TUI popup that appears in
 * that window would otherwise receive the Enter). Mirrors the same delivery
 * choreography — the CoCo keystroke throttle, the paste-line settle, and the
 * generic text-then-beat — but stops before the submit key. Kept next to the
 * submitting variant so the two cannot drift. */
export async function typeRawCommandLine(
  backend: RawCommandWriter,
  content: string,
  opts: RawCommandWriteOptions = {},
): Promise<boolean> {
  const delay = opts.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const beatMs = opts.submitBeatMs ?? 200;
  const sendText = backend.sendText?.bind(backend);
  const pasteText = backend.pasteText?.bind(backend);
  const current = () => opts.isCurrent?.() !== false;
  if (!current()) return false;

  if (backend.sendSpecialKeys) {
    if (opts.coco && sendText) {
      const cmd = content.trim();
      const typed = cmd.includes(' ') ? cmd : `${cmd} `;
      for (const ch of typed) {
        if (!current()) return false;
        if (sendText(ch) === false) return false;
        await delay(opts.cocoThrottleMs ?? 40);
      }
      await delay(beatMs);
      return current();
    }
    if (opts.pasteLine && backend.supportsRawCommandPasteLine && pasteText) {
      if (pasteText(content) === false) return false;
      await delay(opts.pasteSettleMs ?? beatMs);
      return current();
    }
    if (sendText) {
      if (sendText(content) === false) return false;
      await delay(beatMs);
      return current();
    }
  }

  if (backend.write(content) === false) return false;
  await delay(beatMs);
  return current();
}

/** Type one literal input line and report whether both the text and submit
 * writes were accepted by the backend. `undefined` remains legacy success;
 * explicit false is a proven drop and must never produce an activation ACK. */
export async function writeRawCommandLine(
  backend: RawCommandWriter,
  content: string,
  opts: RawCommandWriteOptions = {},
): Promise<boolean> {
  const delay = opts.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const beatMs = opts.submitBeatMs ?? 200;
  const sendText = backend.sendText?.bind(backend);
  const sendSpecialKeys = backend.sendSpecialKeys?.bind(backend);
  const pasteText = backend.pasteText?.bind(backend);
  const current = () => opts.isCurrent?.() !== false;
  if (!current()) return false;

  if (opts.bracketedPaste) {
    if (backend.submitBracketedPaste) return backend.submitBracketedPaste(content) !== false;
    const paste = backend.sendBracketedPaste?.bind(backend) ?? pasteText;
    const accepted = paste ? paste(content) : backend.write(wrapBracketedPaste(content));
    if (accepted === false) return false;
    await delay(beatMs);
    return current() && (sendSpecialKeys ? sendSpecialKeys('Enter') : backend.write('\r')) !== false;
  }
  if (sendSpecialKeys) {
    if (opts.coco && sendText) {
      const cmd = content.trim();
      const typed = cmd.includes(' ') ? cmd : `${cmd} `;
      for (const ch of typed) {
        if (!current()) return false;
        if (sendText(ch) === false) return false;
        await delay(opts.cocoThrottleMs ?? 40);
      }
      await delay(beatMs);
      return current() && sendSpecialKeys('Enter') !== false;
    }
    if (opts.pasteLine && backend.supportsRawCommandPasteLine && pasteText) {
      if (pasteText(content) === false) return false;
      await delay(opts.pasteSettleMs ?? beatMs);
      return current() && sendSpecialKeys('Enter') !== false;
    }
    if (sendText) {
      if (sendText(content) === false) return false;
      await delay(beatMs);
      return current() && sendSpecialKeys('Enter') !== false;
    }
  }

  if (backend.write(content) === false) return false;
  await delay(beatMs);
  return current() && backend.write('\r') !== false;
}

export interface RawCommandDeliveryFinalizer {
  accepted: boolean;
  durableActivation: boolean;
  acknowledgeActivation: boolean;
  hasFollowUp: boolean;
  onAccepted: () => void;
  onFollowUp: () => void;
  onActivationAck: () => void;
  onDurableFailure: () => void;
}

/** Apply the raw-input side effects at the acceptance boundary. A rejected
 * text/Enter write can neither enqueue the follower nor ACK the durable head;
 * it must retire the worker generation so daemon exit recovery keeps the exact
 * journal routable. */
export function finalizeRawCommandDelivery(args: RawCommandDeliveryFinalizer): boolean {
  if (!args.accepted) {
    if (args.durableActivation) args.onDurableFailure();
    return false;
  }
  args.onAccepted();
  if (args.hasFollowUp) args.onFollowUp();
  if (args.acknowledgeActivation) args.onActivationAck();
  return true;
}
