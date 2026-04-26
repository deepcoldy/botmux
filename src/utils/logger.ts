function timestamp(): string {
  return new Date().toISOString();
}

function fmt(msg: string, args: unknown[]): string {
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  return `[${timestamp()}] ${msg}${extra}\n`;
}

// Always log to stderr so stdout stays clean for any consumer that pipes
// daemon/CLI output (PM2, tmux capture-pane, JSON streams, etc.).
const out = process.stderr;

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    out.write(fmt(`[INFO] ${msg}`, args));
  },
  warn(msg: string, ...args: unknown[]): void {
    process.stderr.write(fmt(`[WARN] ${msg}`, args));
  },
  error(msg: string, ...args: unknown[]): void {
    process.stderr.write(fmt(`[ERROR] ${msg}`, args));
  },
  debug(msg: string, ...args: unknown[]): void {
    if (process.env.DEBUG) {
      out.write(fmt(`[DEBUG] ${msg}`, args));
    }
  },
};
