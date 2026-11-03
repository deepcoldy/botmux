import { describe, expect, it } from 'vitest';
import { larkToolExecutionArgs, parseLarkToolInvocation } from '../src/core/lark-tool-command.js';
import { readLarkToolHelp } from './helpers/lark-tool-help.js';

const binding = { appId: 'cli_current', defaultAs: 'bot' as const };
const parse = (args: string[]) => parseLarkToolInvocation(args, binding, readLarkToolHelp);
describe('lark-cli argv metadata', () => {
  it('accepts typed API help with separately grouped parameter sections', () => {
    const invocation = parseLarkToolInvocation(['docs', '+fetch', '--keyword', '--as=user', '--dry-run'], binding, cmd => {
      const help = readLarkToolHelp(cmd);
      return cmd.join(' ') === 'docs +fetch' ? help.replace('Flags:', 'API Parameters:').replace('      --as string', 'Execution:\n      --as string') : help;
    });
    expect(invocation.mode).toBe('bot');
    expect(invocation.args).toContain('--dry-run');
  });

  it('reads snake_case flags declared by shortcut help', () => {
    const readHelp = (cmd: readonly string[]) => {
      const help = readLarkToolHelp(cmd);
      return cmd.join(' ') === 'docs +fetch' ? help.replace('      --dry-run', '      --output_as string   format\n      --dry-run') : help;
    };
    for (const args of [['docs', '+fetch', '--output_as', 'image', '--dry-run'], ['docs', '+fetch', '--output_as=image', '--dry-run']]) {
      const invocation = parseLarkToolInvocation(args, binding, readHelp);
      expect(larkToolExecutionArgs(invocation)).toEqual([...args, '--as', 'bot']);
    }
  });

  it('resolves a lone subcommand listed with Cobra single-space padding', () => {
    const readHelp = (cmd: readonly string[]) => {
      const key = cmd.join(' ');
      if (key === 'docs') return readLarkToolHelp(cmd).replace('+fetch      command', 'metas command');
      if (key === 'docs metas') return 'Usage:\n  lark-cli docs metas [command]\nAvailable Commands:\n  batch_query 获取文件元数据\nFlags:\n  -h, --help   help\n';
      if (key === 'docs metas batch_query') return 'Usage:\n  lark-cli docs metas batch_query [flags]\nRequest Body:\n      --data string   body\nExecution:\n      --as string   identity\nOther:\n  -h, --help   help\n      --json   json\n';
      return readLarkToolHelp(cmd);
    };
    const args = ['docs', 'metas', 'batch_query', '--json', '--data', '{}'];
    expect(larkToolExecutionArgs(parseLarkToolInvocation(args, binding, readHelp))).toEqual([...args, '--as', 'bot']);
  });

  it.each([
    ['docs', '+fetch', '--doc', 'doc-fixture', '--scope', 'keyword', '--keyword', '--as=user', '--dry-run'],
    ['sheets', '+cells-replace', '--replacement', '--as=user', '--dry-run'],
    ['sheets', '+cells-replace', '--description', '--profile=cli_other', '--dry-run'],
    ['docs', '+fetch', '--keyword', '--', '--dry-run'],
    ['docs', '+fetch', '--keyword', '--help', '--dry-run'],
    ['docs', '+fetch', '-q', '--as=user', '--dry-run'],
  ].map(args => ({ args })))('preserves business values and preview: $args', ({ args }) => {
    const invocation = parse(args);
    expect(invocation.mode).toBe('bot');
    expect(invocation.args).toEqual(args);
    expect(invocation.showHelp).toBe(false);
    expect(larkToolExecutionArgs(invocation)).toEqual([...args, '--as', 'bot']);
  });
  it('distinguishes an actual user selector after a flag-shaped payload', () => {
    const args = ['docs', '+fetch', '--keyword', '--as=bot', '--as=user', '--dry-run'];
    const invocation = parse(args);
    expect(invocation.mode).toBe('user');
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--keyword', '--as=bot', '--dry-run', '--as', 'user']);
  });
  it.each([['event', 'list', '--json'], ['event', 'schema', 'im.message.receive_v1'], ['doctor', '--offline']])(
    'runs local discovery without credentials or --as: %s %s', (...args) => {
      const invocation = parse(args);
      expect(invocation.offline).toBe(true);
      expect(invocation.supportsAs).toBe(false);
      expect(larkToolExecutionArgs(invocation)).toEqual(args);
    },
  );
  it('uses command metadata for live commands with and without --as', () => {
    expect(larkToolExecutionArgs(parse(['doctor']))).toEqual(['doctor']);
    expect(larkToolExecutionArgs(parse(['event', 'consume', 'im.event', '--dry-run']))).toEqual(['event', 'consume', 'im.event', '--dry-run', '--as', 'bot']);
  });
  it('refuses unrecognized flag metadata before executing any business command', () => {
    expect(() => parse(['docs', '+fetch', '--new-unknown', '--as=user', '--dry-run'])).toThrow('Unknown lark-cli flag');
    expect(() => parseLarkToolInvocation(['docs', '+fetch'], binding, () => 'invalid help')).toThrow('metadata');
  });
  it('inserts identity before the real terminator and preserves literal arguments', () => {
    const invocation = parse(['docs', '+fetch', '--keyword', '--', '--', '--as=user']);
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--keyword', '--', '--as', 'bot', '--', '--as=user']);
  });
  it('supports --profile switching to another profile as passthrough', () => {
    const invocation = parse(['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_other']);
    expect(invocation.passthroughProfile).toBe('cli_other');
    expect(invocation.args).toEqual(['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_other']);
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_other']);
  });
  it('supports --profile with explicit --as user preserved', () => {
    const invocation = parse(['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_other', '--as=user']);
    expect(invocation.passthroughProfile).toBe('cli_other');
    expect(invocation.mode).toBe('user');
    expect(invocation.sawAs).toBe(true);
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_other', '--as', 'user']);
  });
  it('strips --profile when it matches the bound appId and uses managed bot identity', () => {
    const invocation = parse(['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_current']);
    expect(invocation.passthroughProfile).toBeUndefined();
    expect(invocation.args).toEqual(['docs', '+fetch', '--doc', 'doc-1']);
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--doc', 'doc-1', '--as', 'bot']);
  });
  it.each([
    [['docs', '--profile', 'cli_current', '+fetch', '--doc', 'doc-1'], ['docs', '+fetch', '--doc', 'doc-1']],
    [['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_current'], ['docs', '+fetch', '--doc', 'doc-1']],
    [['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_current', '--dry-run'], ['docs', '+fetch', '--doc', 'doc-1', '--dry-run']],
    [['docs', '+fetch', '--profile=cli_current', '--doc', 'doc-1'], ['docs', '+fetch', '--doc', 'doc-1']],
  ])('accepts the bound app --profile at group or leaf position under bound help metadata: %s', (input, stripped) => {
    const invocation = parse(input);
    expect(invocation.passthroughProfile).toBeUndefined();
    expect(invocation.args).toEqual(stripped);
    expect(larkToolExecutionArgs(invocation)).toEqual([...stripped, '--as', 'bot']);
  });
  it.each([
    ['docs', '--profile', 'cli_other', '+fetch', '--doc', 'doc-1'],
    ['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_other'],
    ['docs', '+fetch', '--doc', 'doc-1', '--profile=cli_other'],
    ['docs', '+fetch', '--profile=cli_other', '--doc', 'doc-1', '--dry-run'],
  ])('passes a foreign --profile through at group or leaf position: %s', (...args) => {
    const invocation = parse(args);
    expect(invocation.passthroughProfile).toBe('cli_other');
    expect(invocation.args).toEqual(args);
    expect(larkToolExecutionArgs(invocation)).toEqual(args);
  });
  it('keeps an explicit --as user alongside a trailing foreign profile', () => {
    const invocation = parse(['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_other', '--as=user']);
    expect(invocation.passthroughProfile).toBe('cli_other');
    expect(invocation.mode).toBe('user');
    expect(larkToolExecutionArgs(invocation)).toEqual(['docs', '+fetch', '--doc', 'doc-1', '--profile', 'cli_other', '--as', 'user']);
  });
  it('does not inherit root-local help/version flags onto a leaf', () => {
    expect(() => parse(['docs', '+fetch', '--version'])).toThrow('Unknown lark-cli flag');
    expect(() => parse(['docs', '+fetch', '-v'])).toThrow('Unknown lark-cli flag');
  });
});
