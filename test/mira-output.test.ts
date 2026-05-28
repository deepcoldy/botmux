import { describe, expect, it } from 'vitest';
import { extractMiraHistoryFinalText, sanitizeMiraFinalText } from '../src/mira-output.js';

describe('sanitizeMiraFinalText', () => {
  it('removes complete cis-ctrl blocks', () => {
    const text = [
      '<cis-ctrl>',
      '{"large":"internal payload"}',
      '</cis-ctrl>',
      '',
      '正常回复',
    ].join('\n');

    expect(sanitizeMiraFinalText(text)).toBe('正常回复');
  });

  it('removes trailing unclosed cis-ctrl blocks', () => {
    const text = '正常回复\n\n<cis-ctrl>{"debug":"still streaming"}';

    expect(sanitizeMiraFinalText(text)).toBe('正常回复');
  });

  it('removes escaped cis-ctrl blocks', () => {
    const text = 'A\n&lt;cis-ctrl type="debug"&gt;hidden&lt;/cis-ctrl&gt;\nB';

    expect(sanitizeMiraFinalText(text)).toBe('A\nB');
  });

  it('preserves normal text', () => {
    expect(sanitizeMiraFinalText(' hello\n\nworld ')).toBe('hello\n\nworld');
  });
});

describe('extractMiraHistoryFinalText', () => {
  it('extracts assistant text from Mira last-round messages', () => {
    const payload = {
      data: {
        messages: [
          { sender: 1, content: 'hello' },
          {
            sender: 2,
            content: JSON.stringify([
              { subtype: 'init', type: 'system' },
              {
                type: 'assistant',
                subtype: 'message',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: '历史回复' }],
                },
              },
            ]),
          },
        ],
      },
    };

    expect(extractMiraHistoryFinalText(payload)).toBe('历史回复');
  });

  it('sanitizes cis-ctrl blocks from history fallback text', () => {
    const payload = {
      data: {
        messages: [{
          sender: 2,
          content: JSON.stringify([{
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '<cis-ctrl>hidden</cis-ctrl>\n用户可见' }],
            },
          }]),
        }],
      },
    };

    expect(extractMiraHistoryFinalText(payload)).toBe('用户可见');
  });
});
