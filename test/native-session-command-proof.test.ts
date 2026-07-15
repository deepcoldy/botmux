import { describe, expect, it } from 'vitest';
import { NativeSessionCommandProof } from '../src/services/native-session-command-proof.js';

describe('NativeSessionCommandProof', () => {
  it.each([
    {
      cliId: 'claude-code' as const,
      command: '/rename Claude title',
      draft: '\x1b[36m❯\x1b[0m\u00a0/rename Claude title  ',
      idle: '\x1b[36m❯\x1b[0m\u00a0',
    },
    {
      cliId: 'codex' as const,
      command: '/rename Codex title',
      draft: '\x1b[1m›\x1b[0m\t/rename Codex title',
      idle: '\x1b[1m›\x1b[0m \x1b[2mWrite tests for @filename\x1b[0m',
    },
  ])('requires an exact $cliId draft before the later empty composer', ({ cliId, command, draft, idle }) => {
    const proof = new NativeSessionCommandProof(command);

    expect(proof.observe(idle, cliId)).toBe(false);
    expect(proof.observe('unrelated output changed the screen hash', cliId)).toBe(false);
    expect(proof.observe(draft, cliId)).toBe(false);
    expect(proof.observe(idle, cliId)).toBe(true);
    expect(proof.observe('screen can change after completion', cliId)).toBe(true);
  });

  it.each([
    {
      cliId: 'claude-code' as const,
      draft: '\x1b[36m❯\x1b[0m\u00a0/rename picker-safe',
      idle: '❯',
    },
    {
      cliId: 'codex' as const,
      draft: '\x1b[1m›\x1b[0m /rename picker-safe',
      idle: '›',
    },
  ])('accepts an exact $cliId draft while slash-command picker rows are visible', ({ cliId, draft, idle }) => {
    const proof = new NativeSessionCommandProof('/rename picker-safe');
    const draftWithPicker = [
      draft,
      '  /rename    Rename this native session',
      '  /resume    Resume a previous session',
    ].join('\n');

    expect(proof.observe(draftWithPicker, cliId)).toBe(false);
    expect(proof.observe(idle, cliId)).toBe(true);
  });

  it('does not arm on a prefix, suffix, or command shown outside the composer', () => {
    const proof = new NativeSessionCommandProof('/rename exact');

    expect(proof.observe('❯ /rename ex', 'claude-code')).toBe(false);
    expect(proof.observe('❯ /rename exact extra', 'claude-code')).toBe(false);
    expect(proof.observe('history: /rename exact', 'claude-code')).toBe(false);
    expect(proof.observe('❯', 'claude-code')).toBe(false);
  });

  it('reconstructs the complete wrapped command before arming phase A', () => {
    const command = '/rename a title that wraps across narrow terminal rows';
    const proof = new NativeSessionCommandProof(command);

    expect(proof.observe(
      '❯ /rename a title that\nwraps across narrow\nterminal rows',
      'claude-code',
    )).toBe(false);
    expect(proof.hasObservedDraft).toBe(true);
    expect(proof.observe('❯', 'claude-code')).toBe(true);
  });

  it.each([
    {
      cliId: 'claude-code' as const,
      command: '/rename a wrapped title ending esc to interrupt',
      screen: '❯ /rename a wrapped title ending\nesc to interrupt',
      idle: '❯',
    },
    {
      cliId: 'codex' as const,
      command: '/rename a wrapped title ending ctrl+c: cancel',
      screen: '› /rename a wrapped title ending\nctrl+c: cancel',
      idle: '›',
    },
  ])('captures a wrapped $cliId draft whose continuation equals a busy hint', ({ cliId, command, screen, idle }) => {
    const proof = new NativeSessionCommandProof(command);

    expect(proof.observe(screen, cliId)).toBe(false);
    expect(proof.hasObservedDraft).toBe(true);
    expect(proof.observe(idle, cliId)).toBe(true);
  });

  it('rejects a long partial draft and a mismatching wrapped suffix', () => {
    const command = '/rename a title that wraps across narrow terminal rows';
    const partial = new NativeSessionCommandProof(command);
    const wrongSuffix = new NativeSessionCommandProof(command);

    expect(partial.observe('❯ /rename a title that wraps', 'claude-code')).toBe(false);
    expect(partial.hasObservedDraft).toBe(false);
    expect(wrongSuffix.observe(
      '❯ /rename a title that\nwraps across narrow\nterminal rowz',
      'claude-code',
    )).toBe(false);
    expect(wrongSuffix.hasObservedDraft).toBe(false);
  });

  it('does not treat an old draft above the current empty composer as a new capture', () => {
    const proof = new NativeSessionCommandProof('/rename repeated');

    expect(proof.observe('❯ /rename repeated\ncommand output\n❯', 'claude-code')).toBe(false);
    expect(proof.observe('❯', 'claude-code')).toBe(false);
  });

  it('does not arm from an old exact composer when the active draft differs', () => {
    const proof = new NativeSessionCommandProof('/rename exact');

    expect(proof.observe(
      '❯ /rename exact\ncommand completed earlier\n❯ /clear',
      'claude-code',
    )).toBe(false);
    expect(proof.hasObservedDraft).toBe(false);
  });

  it.each([
    {
      cliId: 'claude-code' as const,
      command: '/rename historical',
      screen: [
        '❯ /rename historical',
        'Permission request',
        'Allow Bash command?',
        '  1. Yes',
        '  2. No',
      ].join('\n'),
      idle: '❯',
    },
    {
      cliId: 'codex' as const,
      command: '/rename historical',
      screen: [
        '› /rename historical',
        'Select model and effort',
        '  1. gpt-5.4',
        '  2. gpt-5.3',
      ].join('\n'),
      idle: '›',
    },
  ])('does not capture a historical $cliId draft above the active modal', ({ cliId, command, screen, idle }) => {
    const proof = new NativeSessionCommandProof(command);

    expect(proof.observe(screen, cliId)).toBe(false);
    expect(proof.hasObservedDraft).toBe(false);
    expect(proof.observe(idle, cliId)).toBe(false);
  });

  it('ignores picker cursors below the active exact composer', () => {
    const proof = new NativeSessionCommandProof('/rename exact');

    expect(proof.observe('› /rename exact\n› 1. Rename session\n  2. Cancel', 'codex')).toBe(false);
    expect(proof.hasObservedDraft).toBe(true);
  });

  it('allows cancellation-hint words inside the exact title draft', () => {
    const proof = new NativeSessionCommandProof('/rename press esc to interrupt safely');

    expect(proof.observe('❯ /rename press esc to interrupt safely', 'claude-code')).toBe(false);
    expect(proof.hasObservedDraft).toBe(true);
  });

  it('waits through busy and picker screens after capturing the draft', () => {
    const proof = new NativeSessionCommandProof('/rename guarded');

    expect(proof.observe('› /rename guarded', 'codex')).toBe(false);
    expect(proof.observe('Working… esc to interrupt\n›', 'codex')).toBe(false);
    expect(proof.observe('›\nSelect model and effort\n› 1. gpt-5.4', 'codex')).toBe(false);
    expect(proof.observe('›', 'codex')).toBe(true);
  });

  it('does not arm from a busy screen even if an old exact draft is visible', () => {
    const proof = new NativeSessionCommandProof('/rename stale');

    expect(proof.observe('❯ /rename stale\nWorking… esc to interrupt', 'claude-code')).toBe(false);
    expect(proof.observe('❯', 'claude-code')).toBe(false);
  });

  it('keeps capture bound to the CLI whose composer contained the draft', () => {
    const proof = new NativeSessionCommandProof('/rename one-cli');

    expect(proof.observe('❯ /rename one-cli', 'claude-code')).toBe(false);
    expect(proof.observe('›', 'codex')).toBe(false);
    expect(proof.observe('❯', 'claude-code')).toBe(true);
  });

  it('treats an empty capture as no evidence', () => {
    const proof = new NativeSessionCommandProof('/rename no-capture');

    expect(proof.observe('', 'claude-code')).toBe(false);
    expect(proof.observe('❯', 'claude-code')).toBe(false);
  });
});
