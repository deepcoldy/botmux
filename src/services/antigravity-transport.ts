/** Host-owned transport identity prevents writing ACP frames into a surviving native TUI. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Resolve only this bot's explicit opt-in; never inherit another bot's transport. */
export function antigravityTransport(env: Readonly<Record<string, string>> | undefined): 'terminal' | 'acp' {
  const value = env?.AGY_BOTMUX_TRANSPORT;
  if (value === undefined || value === 'terminal') return 'terminal';
  if (value === 'acp') return 'acp';
  throw new Error('AGY_BOTMUX_TRANSPORT must be terminal or acp');
}

/** Freeze the actual fresh process transport; a warm pane cannot change protocols in place. */
export function verifyAntigravityTransport(opts: {
  dataDir: string;
  sessionId: string;
  transport: 'terminal' | 'acp';
  reattach: boolean;
}): void {
  const path = join(opts.dataDir, 'antigravity-transport', `${encodeURIComponent(opts.sessionId)}.txt`);
  if (opts.reattach) {
    const stored = existsSync(path) ? readFileSync(path, 'utf8').trim() : 'terminal';
    if (stored !== opts.transport) throw new Error('Antigravity transport differs from the surviving session; restore its transport setting or start a new session.');
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, opts.transport + '\n', { mode: 0o600 });
}
