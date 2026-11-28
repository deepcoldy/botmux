import { describe, expect, it } from 'vitest';
import {
  codexNativeFooterRows,
  codexSessionRenameSurface,
} from '../src/services/codex-terminal-session.js';

const COMMAND = '/rename [BotMux·Lark] 修复登录页报错';

function indentedWrappedHint(...chrome: string[]): string {
  return [
    '  › Implement',
    '    {feature}',
    ...chrome,
    '  model · /tmp',
  ].join('\n');
}

describe('Codex session-rename composer evidence', () => {
  it('uses the indented prompt Home column for a wrapped native hint', () => {
    const viewport = indentedWrappedHint();
    expect(codexSessionRenameSurface({ viewport, cursor: { x: 4, y: 0 } }, COMMAND)).toBe('unknown');
    // The same visible words are a human draft when the cursor is past Home.
    expect(codexSessionRenameSurface({ viewport, cursor: { x: 18, y: 0 } }, COMMAND)).toBe('blocked');
  });

  it.each([
    '  • Queued for capacity',
    '  ⠋ Resuming session',
  ])('does not absorb native busy chrome into a wrapped hint: %s', chrome => {
    const viewport = indentedWrappedHint(chrome);
    expect(codexSessionRenameSurface({ viewport, cursor: { x: 4, y: 0 } }, COMMAND)).toBe('unknown');
    expect(codexSessionRenameSurface({ viewport, cursor: { x: 18, y: 0 } }, COMMAND)).toBe('blocked');
  });

  it('classifies a draft whose first composer row is blank from its continuation rows', () => {
    const viewport = ['›', `  ${COMMAND}`, '  model · /tmp'].join('\n');
    const cursor = { x: COMMAND.length + 2, y: 1 };
    expect(codexSessionRenameSurface({ viewport, cursor }, COMMAND)).toBe('unsubmitted');
    expect(codexSessionRenameSurface({ viewport, cursor }, '/rename another title')).toBe('blocked');

    const humanDraft = viewport.replace(COMMAND, 'a human draft on the second row');
    expect(codexSessionRenameSurface({ viewport: humanDraft, cursor }, COMMAND)).toBe('blocked');
  });
});

describe('Codex native footer rows', () => {
  it.each([
    'Context 100% left',
    'Context 79% used',
    '  100% context left',
    '79% context used',
  ])('accepts the native single-row context footer %j', footer => {
    expect(codexNativeFooterRows([footer])).toBe(footer.trim());
  });

  it.each([
    'Context unknown left',
    'Context 100% sideways',
    'enter submit  |  esc back',
    'enter select · esc back',
  ])('rejects a non-native or dialog control footer %j', footer => {
    expect(codexNativeFooterRows([footer])).toBeUndefined();
  });
});
