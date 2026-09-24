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
