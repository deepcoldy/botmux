import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('schedule CLI session scope propagation', () => {
  it('copies the current chat/thread scope into scheduler.addTask', () => {
    expect(cliSource).toContain("scope?: 'thread' | 'chat';");
    expect(cliSource).toMatch(/function detectCurrentSession[\s\S]*?scope: s\.scope,/);
    expect(cliSource).toMatch(/const task = scheduler\.addTask\(\{[\s\S]*?scope: cur\?\.scope,[\s\S]*?\}\);/);
  });
});
