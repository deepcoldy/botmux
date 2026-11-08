import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function handle(): PtyHandle {
  const root = mkdtempSync(join(tmpdir(), 'claude-submit-')); roots.push(root);
  const file = join(root, 'session.jsonl'); writeFileSync(file, '');
  return { write: vi.fn(), sendText: vi.fn(), sendSpecialKeys: vi.fn(), claudeJsonlPath: file };
}
async function submit(pty: PtyHandle, content = '<user_message>\n中文第一行\nsecond line\n</user_message>') {
  vi.useFakeTimers();
  const pending = createClaudeCodeAdapter().writeInput(pty, content);
  await vi.runAllTimersAsync();
  return pending;
}
describe('Claude submission transport acceptance', () => {
  it('preserves multiline payload in one explicit paste and verifies queued input', async () => {
    const pty = handle(); const content = '<user_message>\n中文 first\nsecond\\line\n</user_message>';
    pty.sendBracketedPaste = vi.fn(() => true);
    pty.sendSpecialKeys = vi.fn(() => { appendFileSync(pty.claudeJsonlPath!, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content, timestamp: new Date().toISOString() }) + '\n'); return true; });
    const result = await submit(pty, content);
    expect(result?.submitted).not.toBe(false);
    expect(pty.sendBracketedPaste).toHaveBeenCalledExactlyOnceWith(content);
    expect(pty.sendText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
  });
  it.each(['paste', 'text', 'newline', 'submit', 'raw'] as const)('stops additional input after ambiguous %s failure', async stage => {
    const pty = handle();
    if (stage === 'paste') pty.sendBracketedPaste = vi.fn(() => false);
    if (stage === 'text') pty.sendText = vi.fn(() => false);
    if (stage === 'newline') pty.sendSpecialKeys = vi.fn(() => false);
    if (stage === 'submit') { pty.sendBracketedPaste = vi.fn(() => true); pty.sendSpecialKeys = vi.fn(() => false); }
    if (stage === 'raw') { delete pty.sendText; delete pty.sendSpecialKeys; pty.write = vi.fn(() => false); }
    const result = await submit(pty);
    expect(result?.submitted).toBe(false);
    if (stage === 'paste' || stage === 'text') expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
    if (stage === 'newline' || stage === 'submit') expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
    if (stage === 'raw') expect(pty.write).toHaveBeenCalledTimes(1);
    expect(result?.recheck).toBeTypeOf('function');
  });
  it('retains receipt verification after a submit command times out but actually lands', async () => {
    const pty = handle(); const content = 'late receipt';
    pty.sendBracketedPaste = vi.fn(() => true); pty.sendSpecialKeys = vi.fn(() => false);
    const result = await submit(pty, content);
    appendFileSync(pty.claudeJsonlPath!, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content, timestamp: new Date().toISOString() }) + '\n');
    expect(result?.recheck?.()).toBe(true);
    expect(pty.sendSpecialKeys).toHaveBeenCalledTimes(1);
  });
});
