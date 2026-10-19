import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Bot Defaults agent save state patch', () => {
  it('patches Forge launch mode and read-isolation capability from the save response', () => {
    const source = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
    const marker = 'agentSelectionKey: res.body.selectionKey ?? cliKey';
    const start = source.indexOf(marker);
    // Inspect the actual save patch, not a byte window that shifts when fields are added.
    const patchStart = source.lastIndexOf('patchBot(bot.larkAppId, {', start);
    const patchEnd = source.indexOf('\n        });', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(patchStart).toBeGreaterThanOrEqual(0);
    expect(patchEnd).toBeGreaterThan(start);
    const block = source.slice(patchStart, patchEnd);
    expect(block).toContain('cliLaunchMode: res.body.cliLaunchMode ?? null');
    expect(block).toContain('readIsolation: res.body.readIsolation === true');
    expect(block).toContain('readIsolationSupported: res.body.readIsolationSupported === true');
  });
});
