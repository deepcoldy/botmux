/**
 * argv parsing for the dsh runner, in a side-effect-free module so the parse
 * contract is unit-testable without spawning the runner process.
 */
import { parseRunnerFlags } from './runner-common.js';

// Node's setTimeout delay is a 32-bit signed int of ms; a larger value wraps to
// ~1ms and warns. Upstream config/IPC/UI already clamp to this bound, but the
// runner re-validates its own argv so a hand-crafted invocation can't arm an
// overflowing (effectively ~1ms) turn timeout. Mirrors MAX_TURN_TIMEOUT_MS in
// bot-registry.ts.
export const MAX_TURN_TIMEOUT_MS = 2_147_483_647;

export interface Args {
  sessionId: string;
  dshBin: string;
  cwd?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
  model?: string;
  dshProfile?: string;
  bridgePatch?: string;
  /** Opt-in idle watchdog in ms. Absent (the default) means no turn timer is
   *  armed at all — the turn runs until dsh reports idle. */
  turnTimeoutMs?: number;
}

export function parseArgs(argv: string[]): Args {
  // No turnTimeoutMs in the initial object: the watchdog is opt-in, so the
  // absence of --turn-timeout-ms must parse to undefined (a test pins this).
  const out: Args = { sessionId: '', dshBin: '' };
  parseRunnerFlags(argv, out, {
    '--session-id': 'sessionId',
    '--dsh-bin': 'dshBin',
    '--cwd': 'cwd',
    '--bot-name': 'botName',
    '--bot-open-id': 'botOpenId',
    '--locale': 'locale',
    '--model': 'model',
    '--dsh-profile': 'dshProfile',
    '--bridge-patch': 'bridgePatch',
    '--turn-timeout-ms': (target, val) => {
      const n = Number(val);
      // The watchdog is opt-in. An invalid value is ignored (stays disabled)
      // rather than arming a negative timer or an overflowing ~1ms one.
      if (Number.isInteger(n) && n > 0 && n <= MAX_TURN_TIMEOUT_MS) target.turnTimeoutMs = n;
    },
  });
  if (!out.sessionId) throw new Error('--session-id is required');
  if (!out.dshBin) throw new Error('--dsh-bin is required');
  return out;
}
