function timestamp(): string {
  return new Date().toISOString();
}

function fmt(msg: string, args: unknown[]): string {
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  return `[${timestamp()}] ${msg}${extra}\n`;
}

// MCP server (index.ts) uses stdio transport — stdout must stay clean.
// Daemon (index-daemon.ts) can safely use stdout for info/debug logs.
// Detect which mode we're in: if stderr is the only safe channel, use it for all.
const isMcpMode = !process.env.SESSION_DATA_DIR && !process.env.PM2_HOME;

const out = isMcpMode ? process.stderr : process.stdout;

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
