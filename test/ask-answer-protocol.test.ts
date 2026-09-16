import { describe, expect, it, vi } from 'vitest';

import {
  allowsHumanAskChoiceText,
  formatAddressedAskAnswerCommand,
  formatAskAnswerCommand,
  isValidAskAnswerKey,
  parseAskAnswerCommand,
  submitStructuredAskAnswer,
} from '../src/core/ask-answer-protocol.js';
import { stripLeadingMentions } from '../src/im/lark/message-parser.js';

describe('structured ask answer protocol', () => {
  it('round-trips an option key through the reserved native-text command', () => {
    const command = formatAskAnswerCommand('independent');
    expect(command).toBe('/botmux-ask-answer independent');
    expect(parseAskAnswerCommand(`  ${command}  `)).toBe('independent');
  });

  it('addresses the exact turn sender and leaves the receiver an exact protocol command', () => {
    const outbound = formatAddressedAskAnswerCommand('independent', 'ou_ask_origin');
    expect(outbound).toBe('<at user_id="ou_ask_origin"></at> /botmux-ask-answer independent');

    // Lark renders the addressed native text as @name + command and supplies
    // the structured mention list. The daemon strips that prefix before the
    // protocol parser, leaving no card footer or other prose.
    const receiverContent = stripLeadingMentions(
      '@Question Bot /botmux-ask-answer independent',
      [{ name: 'Question Bot' }],
    );
    expect(receiverContent).toBe('/botmux-ask-answer independent');
    expect(parseAskAnswerCommand(receiverContent)).toBe('independent');
  });

  it('rejects a target outside the app-scoped open_id domain', () => {
    expect(() => formatAddressedAskAnswerCommand('independent', 'cli_other_app')).toThrow('invalid ask answer target');
  });

  it('requires the whole message to be the protocol command', () => {
    expect(parseAskAnswerCommand('转述：/botmux-ask-answer independent')).toBeUndefined();
    expect(parseAskAnswerCommand('/botmux-ask-answer independent\n请处理')).toBeUndefined();
    expect(parseAskAnswerCommand('/botmux-ask-answer independent /close')).toBeUndefined();
  });

  it('keeps explicit human choice labels on the legacy free-text path', () => {
    expect(allowsHumanAskChoiceText('host_cross_principal_classification', '独立任务')).toBe(true);
    expect(allowsHumanAskChoiceText('host_cross_principal_classification', '转述：独立任务')).toBe(false);
  });

  it('rejects keys that can escape into another command or grow without bound', () => {
    expect(isValidAskAnswerKey('suggestion')).toBe(true);
    expect(isValidAskAnswerKey('continue_waiting')).toBe(true);
    expect(isValidAskAnswerKey('Independent')).toBe(false);
    expect(isValidAskAnswerKey('independent\n/close')).toBe(false);
    expect(isValidAskAnswerKey(`a${'b'.repeat(64)}`)).toBe(false);
    expect(() => formatAskAnswerCommand('../close')).toThrow('invalid ask answer key');
  });

  it('submits the option key without consulting human-readable choice labels', () => {
    const submit = vi.fn(() => 'accepted' as const);
    const result = submitStructuredAskAnswer({
      text: '/botmux-ask-answer independent',
      by: 'ou_bot',
      actor: { botSender: true, senderUnionId: 'on_bot' },
      findPending: () => ({
        askId: 'ask-1',
        nonce: 'nonce-1',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        rootMessageId: 'om_root',
        sessionId: 'session-1',
        questions: [{
          prompt: '这段显示文案可以任意修改',
          options: [{ key: 'independent', label: '完全不同的显示标签' }],
          multiSelect: false,
        }],
        selections: [[]],
        createdAt: 1,
        deadlineAt: 2,
        settled: false,
      }),
      submit,
    });
    expect(result).toEqual({ kind: 'submitted', key: 'independent', outcome: 'accepted' });
    expect(submit).toHaveBeenCalledWith({
      askId: 'ask-1',
      nonce: 'nonce-1',
      by: 'ou_bot',
      selections: [['independent']],
      actor: { botSender: true, senderUnionId: 'on_bot' },
    });
  });

  it.each([
    ['two single-select questions', false],
    ['two multi-select questions', true],
  ] as const)('rejects %s before submit so the ask remains pending', (_label, multiSelect) => {
    const pending = {
      askId: 'ask-multi-question',
      nonce: 'nonce-multi-question',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      sessionId: 'session-1',
      questions: [
        {
          prompt: 'first',
          options: [{ key: 'prod', label: 'Production' }],
          multiSelect,
        },
        {
          prompt: 'second',
          options: [{ key: 'confirm', label: 'Confirm' }],
          multiSelect,
        },
      ],
      selections: [[], []],
      createdAt: 1,
      deadlineAt: 2,
      settled: false,
    };
    const submit = vi.fn(() => {
      pending.settled = true;
      return 'accepted' as const;
    });

    const result = submitStructuredAskAnswer({
      text: '/botmux-ask-answer prod',
      by: 'ou_bot',
      findPending: () => pending,
      submit,
    });

    expect(result).toEqual({ kind: 'unsupported_multi_question', key: 'prod' });
    expect(submit).not.toHaveBeenCalled();
    expect(pending.settled).toBe(false);
    expect(pending.selections).toEqual([[], []]);
  });
});
