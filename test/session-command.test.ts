import { describe, expect, it } from 'vitest';

import { parseSessionCommandForTest } from '../src/cli/session-command.js';

describe('session command parsing', () => {
  it('parses the headless MVP start command', () => {
    expect(parseSessionCommandForTest([
      'start',
      '--headless',
      '--bot',
      'review-bot',
      '--working-dir',
      '/repo',
      '--prompt-file',
      'task.md',
      '--json',
    ])).toMatchObject({
      ok: true,
      kind: 'start',
      headless: true,
      bot: 'review-bot',
      workingDir: '/repo',
      promptFile: 'task.md',
      json: true,
    });
  });

  it('parses publish to a new group or existing chat', () => {
    expect(parseSessionCommandForTest([
      'publish',
      'hl_demo',
      '--create-group',
      '--name',
      '任务名',
      '--json',
    ])).toMatchObject({
      ok: true,
      kind: 'publish',
      session: 'hl_demo',
      createGroup: true,
      name: '任务名',
      json: true,
    });

    expect(parseSessionCommandForTest([
      'publish',
      'hl_demo',
      '--chat-id',
      'oc_xxx',
    ])).toMatchObject({
      ok: true,
      kind: 'publish',
      session: 'hl_demo',
      createGroup: false,
      chatId: 'oc_xxx',
    });
  });

  it('rejects ambiguous or incomplete publish targets', () => {
    expect(parseSessionCommandForTest(['publish', 'hl_demo']).ok).toBe(false);
    expect(parseSessionCommandForTest([
      'publish',
      'hl_demo',
      '--create-group',
      '--chat-id',
      'oc_xxx',
      '--name',
      '任务名',
    ]).ok).toBe(false);
    expect(parseSessionCommandForTest(['publish', 'hl_demo', '--create-group']).ok).toBe(false);
  });

  it('passes lower-level session commands through to headless internals', () => {
    expect(parseSessionCommandForTest([
      'send',
      'hl_demo',
      '--prompt-file',
      'task.md',
      '--wait',
      '--json',
    ])).toMatchObject({
      ok: true,
      kind: 'passthrough',
      headlessSubcommand: 'send',
      args: ['hl_demo', '--prompt-file', 'task.md', '--wait', '--json'],
      json: true,
    });

    expect(parseSessionCommandForTest([
      'bind',
      'hl_demo',
      '--chat-id',
      'oc_xxx',
      '--scope',
      'thread',
    ])).toMatchObject({
      ok: true,
      kind: 'passthrough',
      headlessSubcommand: 'bind',
    });

    expect(parseSessionCommandForTest(['list', '--json'])).toMatchObject({
      ok: true,
      kind: 'passthrough',
      headlessSubcommand: 'list',
      json: true,
    });
  });
});
