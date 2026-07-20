/** Minimal write surface shared by PTY/session backends for literal slash
 * commands. Historical backends return void on success; guarded backends
 * return false when the target pane/process is already unavailable. */
export interface RawCommandWriter {
  write(data: string): void | boolean;
  sendText?: (text: string) => void | boolean;
  sendSpecialKeys?: (...keys: string[]) => void | boolean;
}

export interface RawCommandWriteOptions {
  coco?: boolean;
  cocoThrottleMs?: number;
  submitBeatMs?: number;
  delay?: (ms: number) => Promise<void>;
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

  if (sendText && sendSpecialKeys) {
    if (opts.coco) {
      const cmd = content.trim();
      const typed = cmd.includes(' ') ? cmd : `${cmd} `;
      for (const ch of typed) {
        if (sendText(ch) === false) return false;
        await delay(opts.cocoThrottleMs ?? 40);
      }
      await delay(beatMs);
      return sendSpecialKeys('Enter') !== false;
    }
    if (sendText(content) === false) return false;
    await delay(beatMs);
    return sendSpecialKeys('Enter') !== false;
  }

  if (backend.write(content) === false) return false;
  await delay(beatMs);
  return backend.write('\r') !== false;
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
