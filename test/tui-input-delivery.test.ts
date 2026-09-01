import { describe, expect, it, vi } from 'bun:test';
import {
  sendTuiKeySequence,
  submitTuiTextInput,
} from '../src/utils/tui-input-delivery.js';

const KEY_TO_ANSI = {
  Down: '\x1b[B',
  Enter: '\r',
};

describe('sendTuiKeySequence', () => {
  it('preserves void-returning backends and sends every key in order', async () => {
    const sent: string[] = [];
    const target = {
      write: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => { sent.push(key); }),
    };

    await expect(sendTuiKeySequence(target, ['Down', 'Enter'], KEY_TO_ANSI, {
      pause: async () => {},
    })).resolves.toBe(true);
    expect(sent).toEqual(['Down', 'Enter']);
  });

  it('stops immediately when a backend explicitly returns false', async () => {
    const target = {
      write: vi.fn(),
      sendSpecialKeys: vi.fn((key: string) => key !== 'Down'),
    };

    await expect(sendTuiKeySequence(target, ['Down', 'Enter'], KEY_TO_ANSI, {
      pause: async () => {},
    })).resolves.toBe(false);
    expect(target.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });

  it('does not continue a sequence after the backend generation changes', async () => {
    let current = true;
    const target = {
      write: vi.fn(),
      sendSpecialKeys: vi.fn(() => true),
    };

    await expect(sendTuiKeySequence(target, ['Down', 'Enter'], KEY_TO_ANSI, {
      isCurrent: () => current,
      pause: async () => { current = false; },
    })).resolves.toBe(false);
    expect(target.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });
});

describe('submitTuiTextInput', () => {
  it('keeps submission failed when the adapter reports submitted:false', async () => {
    const target = {
      write: vi.fn(),
      sendSpecialKeys: vi.fn(() => true),
    };
    const writeInput = vi.fn(async () => ({ submitted: false }));

    await expect(submitTuiTextInput({
      target,
      keys: ['Down', 'Enter'],
      text: 'answer',
      keyToAnsi: KEY_TO_ANSI,
      writeInput,
      pause: async () => {},
    })).resolves.toBe(false);
    expect(target.sendSpecialKeys).toHaveBeenCalledWith('Down');
    expect(target.sendSpecialKeys).not.toHaveBeenCalledWith('Enter');
  });

  it('reports success only after navigation and adapter submission complete', async () => {
    const target = {
      write: vi.fn(),
      sendSpecialKeys: vi.fn(() => true),
    };
    const writeInput = vi.fn(async () => ({ submitted: true }));

    await expect(submitTuiTextInput({
      target,
      keys: ['Down', 'Enter'],
      text: 'answer',
      keyToAnsi: KEY_TO_ANSI,
      writeInput,
      pause: async () => {},
    })).resolves.toBe(true);
    expect(writeInput).toHaveBeenCalledWith(target, 'answer');
  });
});
