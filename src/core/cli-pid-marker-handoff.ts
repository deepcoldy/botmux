/**
 * Handing a live CLI's executing turn from one worker to the next.
 *
 * The CLI PID marker (`<data>/.botmux-cli-pids/<pid>`) records the turn its
 * CLI is executing. When a worker exits without ending the CLI (daemon restart,
 * IPC disconnect, parent watchdog), the successor that reattaches the same CLI
 * takes that turn back from the marker — so the marker must survive exactly
 * those exits, and no others.
 */

/** Whether a CLI keeps running when its worker exits without ending it (daemon
 * restart / IPC disconnect / parent watchdog / crash): a persistent backend
 * (tmux / zellij / herdr / zmx) only DETACHES from its named session and the
 * successor worker reattaches the same CLI; a PTY CLI is a child of the worker
 * and dies with it. */
export function cliSurvivesWorkerExit(input: {
  backendType: string;
  /** Present only when the CLI runs in a named persistent session. */
  persistentSessionName: string | null | undefined;
}): boolean {
  return !!input.persistentSessionName && input.backendType !== 'pty';
}

/** Whether a worker exiting because its parent went away leaves the CLI PID
 * marker for the successor. Only a CLI that is still running and will be
 * reattached hands its turn on. An adopted pane belongs to the user, Codex App
 * recovers its turns from its own exact dispatch ledger, and an RPC engine's
 * turns end with the engine this exit stops: those keep deleting it. */
export function handsCliPidMarkerToSuccessor(input: {
  /** {@link cliSurvivesWorkerExit} for this CLI generation. */
  cliSurvivesExit: boolean;
  /** The CLI has not exited (a backend is still attached). */
  cliRunning: boolean;
  adoptMode: boolean;
  codexApp: boolean;
  rpcEngineEngaged: boolean;
}): boolean {
  return input.cliSurvivesExit
    && input.cliRunning
    && !input.adoptMode
    && !input.codexApp
    && !input.rpcEngineEngaged;
}
