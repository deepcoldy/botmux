/**
 * Claude Code records every executed slash command in its transcript as a
 * `<command-name>/name</command-name>` user line. The worker relies on that
 * record (not on screen heuristics) before typing the first prompt behind a
 * bot startup command, so the probe must only see records appended after its
 * baseline and must ignore a command that never ran.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCommandRecordMarker, createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcriptFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-probe-'));
  dirs.push(dir);
  const path = join(dir, 'projects', 'p', 'sid.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

const userLine = (content: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;

describe('claudeCommandRecordMarker', () => {
  it('derives the record marker from the command token only', () => {
    expect(claudeCommandRecordMarker('/effort xhigh')).toBe('<command-name>/effort</command-name>');
    expect(claudeCommandRecordMarker('  /plugin:do-thing arg  ')).toBe('<command-name>/plugin:do-thing</command-name>');
  });

  it('has no marker for lines that are not slash commands', () => {
    expect(claudeCommandRecordMarker('effort xhigh')).toBeUndefined();
    expect(claudeCommandRecordMarker('/')).toBeUndefined();
    expect(claudeCommandRecordMarker('/eff"ort')).toBeUndefined();
  });
});

describe('claude-code commandExecutionProbe', () => {
  const adapter = createClaudeCodeAdapter();

  it('confirms only a record of THIS command appended after the baseline', () => {
    const path = transcriptFile();
    // A resumed transcript already holds an earlier /effort run.
    appendFileSync(path, userLine('<command-name>/effort</command-name>\n<command-args>high</command-args>'));
    const probe = adapter.commandExecutionProbe!({ write: () => {}, claudeJsonlPath: path }, '/effort xhigh');
    expect(probe).toBeTypeOf('function');
    expect(probe!()).toBe(false);
    // A prompt line, or another command, is not this command's execution.
    appendFileSync(path, userLine('hello'));
    appendFileSync(path, userLine('<command-name>/model</command-name>'));
    expect(probe!()).toBe(false);
    appendFileSync(path, userLine('<command-name>/effort</command-name>\n<command-args>xhigh</command-args>'));
    expect(probe!()).toBe(true);
  });

  it('works for a fresh session whose transcript does not exist yet', () => {
    const path = transcriptFile();
    const probe = adapter.commandExecutionProbe!({ write: () => {}, claudeJsonlPath: path }, '/effort xhigh');
    expect(probe!()).toBe(false);
    appendFileSync(path, userLine('<command-name>/effort</command-name>'));
    expect(probe!()).toBe(true);
  });

  it('has no probe without a transcript path or for a non-command line', () => {
    expect(adapter.commandExecutionProbe!({ write: () => {} }, '/effort xhigh')).toBeUndefined();
    expect(adapter.commandExecutionProbe!({ write: () => {}, claudeJsonlPath: transcriptFile() }, 'effort')).toBeUndefined();
  });
});
