import { describe, expect, it } from 'vitest';
import { parseFlowSlashCommand } from '../src/im/lark/flow-slash-command.js';

describe('parseFlowSlashCommand', () => {
  it('非 /flow 文本返回 null', () => {
    expect(parseFlowSlashCommand('hello')).toBeNull();
    expect(parseFlowSlashCommand('/flowx run a.mjs')).toBeNull();
    expect(parseFlowSlashCommand('/workflow run x')).toBeNull();
  });

  it('裸 /flow 与 help', () => {
    expect(parseFlowSlashCommand('/flow')).toEqual({ kind: 'help' });
    expect(parseFlowSlashCommand('/FLOW help')).toEqual({ kind: 'help' });
  });

  it('run：脚本路径 + --input JSON（含空格）+ 选项', () => {
    expect(parseFlowSlashCommand('/flow run demo/slogan.mjs')).toEqual({ kind: 'run', script: 'demo/slogan.mjs', input: null });
    expect(parseFlowSlashCommand('/flow run demo/slogan.mjs --concurrency 3 --max-duration-min 30 --input {"topic": "tea", "n": 2}')).toEqual({
      kind: 'run',
      script: 'demo/slogan.mjs',
      input: { topic: 'tea', n: 2 },
      concurrency: 3,
      maxDurationMin: 30,
    });
    expect(parseFlowSlashCommand('/flow run "my script.mjs"')).toEqual({ kind: 'run', script: 'my script.mjs', input: null });
  });

  it('run：错误参数', () => {
    expect(parseFlowSlashCommand('/flow run')).toMatchObject({ kind: 'invalid' });
    expect(parseFlowSlashCommand('/flow run a.mjs --input {oops')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('JSON') });
    expect(parseFlowSlashCommand('/flow run a.mjs --concurrency 0')).toMatchObject({ kind: 'invalid' });
    expect(parseFlowSlashCommand('/flow run a.mjs --bogus')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('--bogus') });
  });

  it('ls / inspect / resume / cancel', () => {
    expect(parseFlowSlashCommand('/flow ls')).toEqual({ kind: 'ls' });
    expect(parseFlowSlashCommand('/flow inspect abc-123')).toEqual({ kind: 'inspect', runId: 'abc-123' });
    expect(parseFlowSlashCommand('/flow resume abc-123')).toEqual({ kind: 'resume', runId: 'abc-123' });
    expect(parseFlowSlashCommand('/flow cancel abc-123')).toEqual({ kind: 'cancel', runId: 'abc-123' });
    expect(parseFlowSlashCommand('/flow cancel ../x')).toMatchObject({ kind: 'invalid' });
    expect(parseFlowSlashCommand('/flow inspect')).toMatchObject({ kind: 'invalid' });
  });

  it('signal：runId identity json（json 可含空格）', () => {
    expect(parseFlowSlashCommand('/flow signal r1 pick#1 {"choice": "b"}')).toEqual({ kind: 'signal', runId: 'r1', identity: 'pick#1', value: { choice: 'b' } });
    expect(parseFlowSlashCommand('/flow signal r1 pick#1')).toMatchObject({ kind: 'invalid' });
    expect(parseFlowSlashCommand('/flow signal r1 pick#1 nope')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('JSON') });
  });

  it('未知子命令', () => {
    expect(parseFlowSlashCommand('/flow frobnicate')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('frobnicate') });
  });
});
