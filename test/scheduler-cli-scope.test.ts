import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('schedule CLI session scope propagation', () => {
  it('resolves the requested/current execution position into scheduler.addTask', () => {
    expect(cliSource).toContain("scope?: 'thread' | 'chat';");
    expect(cliSource).toMatch(/function detectCurrentSession[\s\S]*?scope: s\.scope,/);
    expect(cliSource).toMatch(/const executionPosition: 'top-level' \| 'topic' \| 'new-topic' =[\s\S]*?cur\?\.scope/);
    expect(cliSource).toMatch(/const scope: 'thread' \| 'chat' = executionPosition === 'topic'/);
    expect(cliSource).toMatch(/const task = scheduler\.addTask\(\{[\s\S]*?\bscope,[\s\S]*?\bexecutionPosition,[\s\S]*?\btopicTitle,[\s\S]*?\}\);/);
    expect(cliSource).not.toContain('--new-topic 与 --silent 不能同时使用');
    expect(cliSource).toMatch(/const silent = rest\.includes\('--silent'\)[\s\S]*?executionPosition[\s\S]*?scheduler\.addTask/);
  });
});
