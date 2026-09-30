import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Bot Defaults agent save state patch', () => {
  it('patches Forge launch mode and read-isolation capability from the save response', () => {
    const source = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const marker = 'agentSelectionKey: res.body.selectionKey ?? cliKey';
    const start = source.indexOf(marker);
    const block = source.slice(Math.max(0, start - 800), start + 400);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain('cliLaunchMode: res.body.cliLaunchMode ?? null');
    expect(block).toContain('readIsolation: res.body.readIsolation === true');
    expect(block).toContain('readIsolationSupported: res.body.readIsolationSupported === true');
  });
});
