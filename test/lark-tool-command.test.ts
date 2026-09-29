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

  it.each([
    ['docs', '+fetch', '--doc', 'doc-fixture', '--scope', 'keyword', '--keyword', '--as=user', '--dry-run'],
    ['sheets', '+replace', '--replacement', '--as=user', '--dry-run'],
    ['sheets', '+replace', '--description', '--profile=cli_other', '--dry-run'],
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
});
