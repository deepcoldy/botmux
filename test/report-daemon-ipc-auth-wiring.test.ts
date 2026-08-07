import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function reportCommandSource(): string {
  const source = readFileSync(resolve('src/cli.ts'), 'utf8');
  const start = source.indexOf('async function cmdReport(');
  const end = source.indexOf('// ─── Exact chat-grant subcommand', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('botmux report daemon IPC auth wiring', () => {
  it('uses the authenticated daemon client for same-host orchestrator injection', () => {
    const source = reportCommandSource();

    expect(source).toContain(
      "response = await fetchDaemonIpc(daemon.ipcPort, '/api/trigger', {",
    );
    expect(source).not.toContain(
      'response = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/trigger`',
    );
  });
});
