import { describe, expect, it } from 'vitest';
import { isAntigravityInterruptedScreen } from '../src/adapters/cli/antigravity.js';

const interrupted = [
  '● Bash(sleep 30)',
  '  ⎿  Interrupted · What should Antigravity CLI do instead?',
  '────────────────────────',
  '>',
  '────────────────────────',
  '? for shortcuts          accept-edits · Gemini 3.8 Flash · high',
  '',
  '   ',
].join('\n');

describe('Antigravity explicit interruption viewport', () => {
  it('recognizes the interrupted empty composer even without a transcript cancellation', () => {
    expect(isAntigravityInterruptedScreen(interrupted)).toBe(true);
  });

  it('recognizes tmux viewport colors, alternate-screen seed and CRLF rows', () => {
    const colored = '\x1b[?1049h\x1b[H\x1b[2J'
      + interrupted.split('\n').map(line => `\x1b[38;2;100;100;100m${line}\x1b[0m`).join('\r\n');
    expect(isAntigravityInterruptedScreen(colored)).toBe(true);
  });

  it('handles many blank rows and rejects subsequent output without multiline backtracking', () => {
    const tall = interrupted + '\n'.repeat(10_000);
    expect(isAntigravityInterruptedScreen(tall)).toBe(true);
    expect(isAntigravityInterruptedScreen(tall + 'new output')).toBe(false);
  });

  it('accepts PTY snapshots whose display cleanup removes box-drawing rows', () => {
    expect(isAntigravityInterruptedScreen(interrupted.replace(/[─━]/g, ''))).toBe(true);
  });

  it.each([
    interrupted.replace('\n>\n', '\n> next request\n'),
    interrupted.replace('accept-edits', 'esc to cancel'),
    interrupted + '\n● Bash(next command)',
    interrupted.replace('────────────────────────\n>', 'A newer response\n>'),
    interrupted.replace('  ⎿  Interrupted · What should Antigravity CLI do instead?\n', ''),
    interrupted.replace('? for shortcuts', 'Allow this command?'),
    '',
  ])('does not infer cancellation from stale history, a draft, activity or missing evidence (%#)', screen => {
    expect(isAntigravityInterruptedScreen(screen)).toBe(false);
  });
});
