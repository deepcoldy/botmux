import { describe, expect, it } from 'bun:test';
import { parseTraexUserInputQuestions } from '../src/services/traex-user-input.js';

describe('parseTraexUserInputQuestions', () => {
  it('preserves every answerable question and its stable id', () => {
    const result = parseTraexUserInputQuestions({
      questions: [
        {
          id: 'environment',
          question: 'Choose an environment',
          multiSelect: true,
          options: [{ label: 'staging' }, { label: 'production' }],
        },
        {
          id: 'notify',
          header: 'Notification',
          question: 'Choose a notification channel',
          multiSelect: false,
          options: [{ label: 'Lark' }, { label: 'Email' }],
        },
      ],
    });

    expect(result).toEqual({
      kind: 'answerable',
      questions: [
        {
          id: 'environment',
          question: {
            prompt: 'Choose an environment',
            multiSelect: true,
            options: [{ key: 'staging', label: 'staging' }, { key: 'production', label: 'production' }],
          },
        },
        {
          id: 'notify',
          question: {
            prompt: 'Choose a notification channel',
            multiSelect: false,
            options: [{ key: 'Lark', label: 'Lark' }, { key: 'Email', label: 'Email' }],
          },
        },
      ],
    });
  });

  it('rejects an entire mixed batch when one question cannot be represented as buttons', () => {
    const result = parseTraexUserInputQuestions({
      questions: [
        {
          id: 'choice',
          question: 'Continue?',
          multiSelect: false,
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        {
          id: 'free_text',
          question: 'Explain why',
          multiSelect: false,
        },
      ],
    });

    expect(result).toEqual({
      kind: 'unsupported',
      reason: 'question 2 has fewer than two options',
    });
  });

  it('rejects duplicated question ids instead of overwriting an answer', () => {
    const result = parseTraexUserInputQuestions({
      questions: [
        { id: 'choice', question: 'One?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'choice', question: 'Two?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] },
      ],
    });

    expect(result).toEqual({
      kind: 'unsupported',
      reason: 'duplicate question id: choice',
    });
  });
});
