import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const cardHandlerSource = readFileSync(
  new URL('../src/im/lark/card-handler.ts', import.meta.url),
  'utf8',
);

function sourceRegion(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source anchor: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source anchor: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('TUI input failure contract wiring', () => {
  it('treats an explicit backend false as a failed key sequence', () => {
    const region = sourceRegion(
      workerSource,
      'async function handleTuiKeys',
      '// 待注入的 TUI 命令队列',
    );

    expect(region).toMatch(/sendSpecialKeys\(key\)\s*===\s*false|sendTuiKeySequence/);
  });

  it('clears prompt blocking only after text submission succeeds', () => {
    const region = sourceRegion(
      workerSource,
      'async function handleTuiTextInput',
      '/**\n * Drive CoCo',
    );
    const writeIndex = Math.max(
      region.indexOf('targetAdapter.writeInput'),
      region.indexOf('submitTuiTextInput'),
    );
    const clearIndex = region.indexOf('tuiPromptBlocking = false');

    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(writeIndex);
    expect(region).toMatch(/submitted\s*===\s*false|submitTuiTextInput/);
  });

  it('does not claim non-stuck keys were written when the worker helper failed', () => {
    const region = sourceRegion(
      workerSource,
      "case 'tui_keys':",
      "case 'inject_command':",
    );

    expect(region).not.toMatch(
      /await handleTuiKeys\(msg\.keys, msg\.isFinal\);\s*wroteKeys = true;/,
    );
  });

  it('waits for IPC delivery callbacks instead of treating send return false as failure', () => {
    const keysRegion = sourceRegion(
      cardHandlerSource,
      "if (actionType === 'tui_keys' && ds)",
      "if (actionType === 'tui_text_input' && ds)",
    );
    const textRegion = sourceRegion(
      cardHandlerSource,
      "if (actionType === 'tui_text_input' && ds)",
      '// Compatibility path for cards emitted before open_local_cli',
    );

    expect(keysRegion).toContain('await sendWorkerIpc');
    expect(textRegion).toContain('await sendWorkerIpc');
  });
});
