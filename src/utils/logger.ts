function timestamp(): string {
  return new Date().toISOString();
}

function fmt(msg: string, args: unknown[]): string {
  const extra = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
  return `[${timestamp()}] ${msg}${extra}\n`;
}

// MCP server (index.ts) uses stdio transport — stdout must stay clean.
// Always use stderr for log output — it's safe in both MCP and daemon mode,
// and avoids misdetection (the MCP subprocess receives SESSION_DATA_DIR via --env).
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
