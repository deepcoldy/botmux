import { isProgramStatusRelayArgv } from './program-status-relay-launch.js';
import { getChildPids, readCmdline, readComm } from './session-discovery.js';
import { sessionScopePayloadPid } from './session-scope.js';

/** A launch layer botmux itself puts between a pane process and the CLI. */
export type BotmuxLaunchLayer = 'program-status-relay' | 'session-scope';

export interface LaunchLayerProbes {
  readCmdline: (pid: number) => string[];
  childrenOf: (pid: number) => number[];
  commOf: (pid: number) => string | undefined;
  /** The session-scope supervisor's payload pid, or `pid` itself when `pid` is
   *  not that supervisor (see {@link sessionScopePayloadPid}). */
  scopePayloadOf: (pid: number) => number;
}

const DEFAULT_PROBES: LaunchLayerProbes = {
  readCmdline,
  childrenOf: getChildPids,
  commOf: readComm,
  scopePayloadOf: pid => sessionScopePayloadPid(pid),
};

export interface UnwrappedLaunchLayers {
  /** Deepest pid reached: the CLI, or a wrapperCli launcher in front of it. */
  pid: number;
  /** Layers unwrapped so far, outermost first. */
  layers: BotmuxLaunchLayer[];
  /** Every pid from the pane down to `pid`, inclusive. */
  chain: number[];
}

/**
 * Unwrap the launch layers botmux put in front of the CLI. Their order is
 * fixed by how the worker builds the pane command:
 *
 *   pane = [program-status relay] → [session-scope supervisor sh] → payload
 *
 * The relay stays outermost: its launch shim is a shell script with `$VAR`
 * references, which systemd-run would expand. Each layer is recognised only by
 * its exact argv and must have exactly one child (the relay's transient `stty`
 * does not count); anything else ends the walk where it is. So a layer that has
 * not forked or exec'd yet stops the walk short — callers that launched it poll
 * until `layers` holds everything they launched.
 *
 * `relay`: whether the pane may be a relay at all (a tmux pane, or one this
 * spawn launched behind it). Any other backend never runs one, whatever its
 * argv looks like.
 */
export function unwrapBotmuxLaunchLayers(
  panePid: number,
  opts: { relay: boolean; probes?: Partial<LaunchLayerProbes> },
): UnwrappedLaunchLayers {
  const probes = { ...DEFAULT_PROBES, ...opts.probes };
  const layers: BotmuxLaunchLayer[] = [];
  const chain = [panePid];
  let pid = panePid;
  if (opts.relay && isProgramStatusRelayArgv(probes.readCmdline(pid))) {
    const children = probes.childrenOf(pid).filter(child => probes.commOf(child) !== 'stty');
    if (children.length !== 1) return { pid, layers, chain };
    pid = children[0];
    layers.push('program-status-relay');
    chain.push(pid);
  }
  const payload = probes.scopePayloadOf(pid);
  if (payload !== pid) {
    pid = payload;
    layers.push('session-scope');
    chain.push(pid);
  }
  return { pid, layers, chain };
}
