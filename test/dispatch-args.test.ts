import { type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDispatchArgs } from '../src/cli/dispatch-args.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

describe('parseDispatchArgs', () => {
  it('preserves every documented legacy option and both value spellings', () => {
    expect(parseDispatchArgs([
      '--title=task',
      '--bot-app', 'cli_worker:coder',
      '--bot-app=cli_reviewer:reviewer',
      '--bot', 'ou_legacy:Legacy:observer',
      '--brief-file=/tmp/brief.md',
      '--chat-id', 'oc_chat',
      '--repo=/repo',
      '--model=gpt-6-astra',
      '--reasoning-effort', 'high',
      '--into', 'om_root',
      '--session-id=sid',
      '--standby',
      '--steer',
    ])).toEqual({
      ok: true,
      value: {
        help: false,
        title: 'task',
        botApps: ['cli_worker:coder', 'cli_reviewer:reviewer'],
        bots: ['ou_legacy:Legacy:observer'],
        briefFile: '/tmp/brief.md',
        chatId: 'oc_chat',
        repo: '/repo',
        model: 'gpt-6-astra',
        reasoningEffort: 'high',
        into: 'om_root',
        sessionId: 'sid',
        standby: true,
        steer: true,
      },
    });
  });

  it('keeps --brief text verbatim', () => {
    const result = parseDispatchArgs(['--title', 't', '--bot-app', 'cli_a', '--brief', '  keep me  ']);
    expect(result).toMatchObject({ ok: true, value: { brief: '  keep me  ' } });
  });

  it('preserves explicit empty values for downstream legacy validation and fallback', () => {
    expect(parseDispatchArgs(['--title', '', '--brief=', '--repo=']))
      .toMatchObject({ ok: true, value: { title: '', brief: '', repo: '' } });
  });

  it('preserves legacy dash-prefixed values in space-separated form', () => {
    expect(parseDispatchArgs(['--brief', '- item one']))
      .toMatchObject({ ok: true, value: { brief: '- item one' } });
    expect(parseDispatchArgs(['--brief', '-x']))
      .toMatchObject({ ok: true, value: { brief: '-x' } });
    expect(parseDispatchArgs(['--title', '-x']))
      .toMatchObject({ ok: true, value: { title: '-x' } });
  });

  it.each([
    ['--mdoel', ['--mdoel', 'gpt-5']],
    ['--unknown=value', ['--unknown=value']],
  ])(
    'rejects unknown option %s instead of silently dispatching',
    (_label, optionArgs) => {
      const result = parseDispatchArgs(['--title', 't', '--bot-app', 'cli_a', '--brief', 'b', ...optionArgs]);
      expect(result).toMatchObject({ ok: false, errorCode: 'UNKNOWN_OPTION' });
    },
  );

  it('rejects positional arguments', () => {
    expect(parseDispatchArgs(['--title', 't', 'stray'])).toEqual({
      ok: false,
      errorCode: 'UNEXPECTED_ARGUMENT',
      error: 'unexpected positional argument: stray',
    });
  });

  it.each(['--title', '--bot-app'])(
    'rejects missing value for %s',
    (option) => {
      const result = parseDispatchArgs([option]);
      expect(result).toMatchObject({ ok: false, errorCode: 'OPTION_VALUE_REQUIRED' });
    },
  );

  it.each(['--model', '--reasoning-effort'])(
    'rejects missing launch-spec value for %s',
    (option) => expect(parseDispatchArgs([option]))
      .toMatchObject({ ok: false, errorCode: 'OPTION_VALUE_REQUIRED' }),
  );

  it('preserves first-wins singleton and idempotent boolean behavior', () => {
    expect(parseDispatchArgs(['--title', 'a', '--title', 'b']))
      .toMatchObject({ ok: true, value: { title: 'a' } });
    expect(parseDispatchArgs(['--standby', '--standby', '--steer', '--steer']))
      .toMatchObject({ ok: true, value: { standby: true, steer: true } });
  });

  it.each(['--model', '--reasoning-effort'])('rejects duplicate launch option %s', option => {
    expect(parseDispatchArgs([option, 'one', option, 'two']))
      .toMatchObject({ ok: false, errorCode: 'DUPLICATE_OPTION', option });
  });

  it('preserves repeatable bot flags', () => {
    expect(parseDispatchArgs(['--bot-app', 'cli_a', '--bot-app', 'cli_b']))
      .toMatchObject({ ok: true, value: { botApps: ['cli_a', 'cli_b'] } });
  });

  it('keeps both brief sources so cmdDispatch retains brief-file precedence', () => {
    expect(parseDispatchArgs(['--brief', 'inline', '--brief-file', '/tmp/brief']))
      .toMatchObject({
        ok: true,
        value: { brief: 'inline', briefFile: '/tmp/brief' },
      });
  });

  it('preserves help short-circuit even alongside incomplete or unknown arguments', () => {
    expect(parseDispatchArgs(['--help', '--title'])).toMatchObject({ ok: true, value: { help: true } });
    expect(parseDispatchArgs(['--unknown', '-h'])).toMatchObject({ ok: true, value: { help: true } });
  });

  it('rejects a misspelled launch option at the CLI boundary before transport setup', () => {
    const result = spawnSyncTsScript(
      resolve('src/cli.ts'),
      ['dispatch', '--title', 'task', '--mdoel', 'gpt-5'],
      { cwd: resolve('.'), encoding: 'utf8' },
    ) as SpawnSyncReturns<string>;

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      success: false,
      errorCode: 'UNKNOWN_OPTION',
      detail: 'unknown option: --mdoel',
      option: '--mdoel',
    });
  });
});
