/** Bot-default model values are written to bots.json and handed to the CLI as a
 * launch argument, never typed into a terminal, so they may also carry a
 * `#variant` suffix (e.g. MiniMax's `MiniMax-M3.1-Flash#thinking`). Without it
 * a stored variant renders as "CLI default" and cannot be re-selected. Session
 * pickers inject `/model <slug>` into the PTY and keep the strict pattern. */
export const DEFAULT_MODEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:#[A-Za-z0-9._-]{1,32})?$/;
