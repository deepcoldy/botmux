/**
 * Codex writes the submitted composer text to history.jsonl trimmed (verified
 * with real Codex 0.150.0 / 0.164.0 / 0.166.0 / 0.167.0 under tmux). A message
 * that starts or ends with whitespace therefore never appears byte-for-byte, so
 * exact matching reported submit_unconfirmed for turns Codex had executed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const SID = '019dd80d-d922-7a11-8339-0208d8c5b4ee';

let home: string;
let historyPath: string;
let prevCodexHome: string | undefined;
let prevScale: string | undefined;

function historyLine(text: string): string {
  return `${JSON.stringify({ session_id: SID, text, ts: 0 })}\n`;
}

function fakePty(onSubmit?: (content: string) => void): PtyHandle {
  return {
    write() {},
    pasteText() {},
    submitBracketedPaste(content: string) { onSubmit?.(content); },
  } as unknown as PtyHandle;
}

beforeEach(() => {
  prevScale = process.env.BOTMUX_TIME_SCALE;
  process.env.BOTMUX_TIME_SCALE = '0.01';
  prevCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), 'bmx-codex-trim-'));
  process.env.CODEX_HOME = home;
  historyPath = join(home, 'history.jsonl');
  writeFileSync(historyPath, '');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevScale === undefined) delete process.env.BOTMUX_TIME_SCALE; else process.env.BOTMUX_TIME_SCALE = prevScale;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
});

describe('codex writeInput history match tolerates Codex trimming', () => {
  it.each([
    ['trailing newline', 'col1\tcol2\ntrailing newline\n'],
    ['leading indent', '  indented start'],
    ['both ends with CRLF', '\r\n  first line\r\nsecond line  \r\n'],
  ])('confirms in-band when Codex records the %s message trimmed', async (_label, content) => {
    const adapter = createCodexAdapter();
    const result = await adapter.writeInput!(
      fakePty((sent) => appendFileSync(historyPath, historyLine(sent.replace(/\r\n?/g, '\n').trim()))),
      content,
    );
    expect(result).toMatchObject({ submitted: true, cliSessionId: SID });
  });

  it('the deferred recheck also confirms a late trimmed history line', async () => {
    const adapter = createCodexAdapter();
    const content = 'late answer\n';
    const result = await adapter.writeInput!(fakePty(), content) as any;
    expect(result.submitted).toBe(false);
    expect(result.recheck()).toBe(false);
    appendFileSync(historyPath, historyLine('late answer'));
    expect(result.recheck()).toMatchObject({ submitted: true, cliSessionId: SID });
  });

  it('still rejects a line whose text differs beyond edge whitespace', async () => {
    const adapter = createCodexAdapter();
    const result = await adapter.writeInput!(
      fakePty(() => appendFileSync(historyPath, historyLine('trailing newline'))),
      'col1\tcol2\ntrailing newline\n',
    ) as any;
    expect(result.submitted).toBe(false);
    expect(result.recheck()).toBe(false);
  });

  it('does not relax whitespace INSIDE the message', async () => {
    // Edge trimming must not also fold interior whitespace: a record that only
    // matches after collapsing internal runs is a different message.
    const adapter = createCodexAdapter();
    const result = await adapter.writeInput!(
      fakePty(() => appendFileSync(historyPath, historyLine('a b'))),
      'a  b\n',
    ) as any;
    expect(result.submitted).toBe(false);
    expect(result.recheck()).toBe(false);
  });

  it('whitespace-only input never matches an empty history line', async () => {
    const adapter = createCodexAdapter();
    const result = await adapter.writeInput!(
      fakePty(() => appendFileSync(historyPath, historyLine(''))),
      ' \n ',
    ) as any;
    expect(result.submitted).toBe(false);
    expect(result.recheck()).toBe(false);
  });
});
