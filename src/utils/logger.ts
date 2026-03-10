function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    process.stdout.write(`[${timestamp()}] [INFO] ${msg} ${args.map(a => JSON.stringify(a)).join(' ')}\n`);
  },
  warn(msg: string, ...args: unknown[]): void {
    process.stderr.write(`[${timestamp()}] [WARN] ${msg} ${args.map(a => JSON.stringify(a)).join(' ')}\n`);
  },
  error(msg: string, ...args: unknown[]): void {
    process.stderr.write(`[${timestamp()}] [ERROR] ${msg} ${args.map(a => JSON.stringify(a)).join(' ')}\n`);
  },
  debug(msg: string, ...args: unknown[]): void {
    if (process.env.DEBUG) {
      process.stdout.write(`[${timestamp()}] [DEBUG] ${msg} ${args.map(a => JSON.stringify(a)).join(' ')}\n`);
    }
  },
};
