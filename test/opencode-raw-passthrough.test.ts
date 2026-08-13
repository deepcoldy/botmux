import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { rawCommandWriteOptionsFor } from '../src/core/raw-command-write-options.js';
import { writeRawCommandLine } from '../src/core/raw-command-writer.js';

describe('OpenCode raw slash command passthrough', () => {
  it('delivers `/mr-review-team 127` through paste-line raw writer without writeInput wrapping', async () => {
    // Given: OpenCode declares paste-line raw command capability and a backend
    // records the concrete terminal transport operations.
    const calls: string[] = [];
    const adapter = createOpenCodeAdapter('/bin/opencode');
    const writeInput = vi.spyOn(adapter, 'writeInput');
    const write = vi.fn((data: string) => {
      calls.push(`write:${data}`);
      return true;
    });
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });

    // When: the Botmux raw passthrough seam maps OpenCode adapter capability
    // into the raw writer for the exact slash command with arguments.
    const accepted = await writeRawCommandLine(
      { supportsRawCommandPasteLine: true, write, sendText, pasteText, sendSpecialKeys },
      '/mr-review-team 127',
      { ...rawCommandWriteOptionsFor(adapter, 'opencode'), delay },
    );

    // Then: raw delivery pastes the whole line once, submits with a separate
    // Enter after the paste settle, and never routes through normal writeInput.
    expect(accepted).toBe(true);
    expect(pasteText).toHaveBeenCalledOnce();
    expect(pasteText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(sendText).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(writeInput).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'pasteText:/mr-review-team 127',
      'delay:300',
      'sendSpecialKeys:Enter',
    ]);
  });
});
