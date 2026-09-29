import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runProcessCommandExecutor = vi.hoisted(() => vi.fn());

vi.mock('../src/services/command-executors.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/command-executors.js')>();
  return { ...actual, runProcessCommandExecutor };
});

import { CommandExecutorError } from '../src/services/command-executors.js';
import {
  executeFrozenCommand,
  FrozenCommandError,
  lookupFrozenCommand,
  resolveFrozenCommandOutput,
} from '../src/services/frozen-command.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  runProcessCommandExecutor.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('frozen-command executor gate wiring', () => {
  it('does not hand off script artifact drift through an unconditional output rule', async () => {
    const lexicalRoot = join(tmpdir(), `botmux-executor-gate-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(lexicalRoot, { recursive: true });
    const root = realpathSync(lexicalRoot);
    roots.push(root);
    const script = join(root, 'executor.mjs');
    writeFileSync(script, `console.log(JSON.stringify({ value: process.argv.at(-1) }));\n`);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.echo
    kind: script
    executable:
      realpath: ${JSON.stringify(resolve(process.execPath))}
    fixedArgs: [${JSON.stringify(script)}]
    scriptArtifacts: [${JSON.stringify(script)}]
    arguments:
      value:
        flag: --value
        type: string
        required: true
        maxLength: 50
        pattern: "^[A-Za-z ]+$"
        accepts: [param]
    policy:
      schedulable: false
      allowHandoff: true
      handoffIncludesInput: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
      exposeFields: [value]
`);
    const commandRoot = join(root, 'repo');
    mkdirSync(join(commandRoot, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(commandRoot, '.botmux', 'commands', '回显.yaml'), `
schemaVersion: 2
name: 回显
description: 回显测试
params:
  - name: word
    type: string
    maxLength: 50
    pattern: "^[A-Za-z ]+$"
steps:
  - id: main
    executor: test.echo
    input:
      value: "{{word}}"
    renderer: builtin.table
output:
  format: text
  rules:
    - handoff:
        prompt: "请解释执行结果"
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const lookup = lookupFrozenCommand({ workingDir: commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    runProcessCommandExecutor.mockRejectedValueOnce(new CommandExecutorError(
      'executor_artifact_changed',
      '执行器 test.echo 的脚本制品已变化，必须重新确认依赖命令',
    ));

    let executionError: FrozenCommandError | undefined;
    try {
      await executeFrozenCommand({
        definition: lookup.snapshot.definition,
        rawArgs: 'hello',
        targetLarkAppId: 'cli_test',
        botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
        trustedCaller: {
          requestUserOpenId: 'ou_test',
          requestUserUnionId: 'on_test',
          requestLarkAppId: 'cli_test',
          senderType: 'user',
        },
        turnId: 'om_artifact_drift',
        workingDir: commandRoot,
      });
    } catch (error) {
      if (error instanceof FrozenCommandError) executionError = error;
      else throw error;
    }

    expect(runProcessCommandExecutor).toHaveBeenCalledOnce();
    expect(executionError).toMatchObject({
      code: 'executor_artifact_changed',
      executionFailure: false,
    });
    expect(() => resolveFrozenCommandOutput({
      definition: lookup.snapshot.definition,
      rawArgs: 'hello',
      source: 'direct',
      error: executionError!,
    })).toThrow(executionError);
  });
});
