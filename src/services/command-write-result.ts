/** Backends with an out-of-band command transport (notably TmuxPipeBackend)
 * return false when a keystroke was dropped instead of throwing, so generic
 * command writers must promote that explicit failure into their normal catch
 * path. Backends that cannot report delivery return void and remain accepted. */
export class CommandWriteDroppedError extends Error {
  constructor(
    phase: string,
    readonly inputMayBePartial: boolean,
  ) {
    super(`${phase} was dropped by the session backend`);
    this.name = 'CommandWriteDroppedError';
  }
}

export function assertCommandWriteIssued(
  result: void | boolean,
  phase: string,
  inputMayBePartial: boolean,
): void {
  if (result === false) throw new CommandWriteDroppedError(phase, inputMayBePartial);
}

/** Unknown/throwing transports are conservative: only our explicit false
 * result before any earlier command bytes is proof that the composer stayed
 * untouched. */
export function commandWriteMayHavePartialInput(error: unknown): boolean {
  return !(error instanceof CommandWriteDroppedError) || error.inputMayBePartial;
}
