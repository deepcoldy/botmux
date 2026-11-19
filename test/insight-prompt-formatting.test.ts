import { describe, expect, it } from 'vitest';
import { safePromptPreview } from '../src/services/insight/prompt.js';

describe('insight prompt formatting metadata', () => {
  it('removes botmux formatting guidance from bare transcript prompts', () => {
    expect(safePromptPreview(
      '继续\n\n<botmux_formatting>internal formatting guidance</botmux_formatting>',
    )?.text).toBe('继续');
  });
});
