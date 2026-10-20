import { describe, expect, it } from 'vitest';
import { holdsOnlyMention, inputHolds, normalizeInput } from './e2e-browser/helpers.js';

describe('Feishu E2E mention check', () => {
  it('accepts only the intended bot chip, never a bare query or a neighbour', () => {
    expect(holdsOnlyMention('@[Botmux]Claude ', 'Claude')).toBe(true);
    expect(holdsOnlyMention('@BotmuxCodex ', 'Codex')).toBe(true);
    // The typed filter query before a pick has no display name yet.
    expect(holdsOnlyMention('@Claude', 'Claude')).toBe(false);
    // CI picked neighbouring bots from the dropdown.
    expect(holdsOnlyMention('@[Botmux]Aiden ', 'Claude')).toBe(false);
    expect(holdsOnlyMention('@[Botmux]OpenCode ', 'Codex')).toBe(false);
    expect(holdsOnlyMention('@[Botmux]Claude @[Botmux]Codex ', 'Claude')).toBe(false);
    // A stray literal @ broke `/reply-mode` parsing in CI.
    expect(holdsOnlyMention('@@[Botmux]Claude ', 'Claude')).toBe(false);
  });
});

describe('Feishu E2E typed-input check', () => {
  const zw = '​';
  it('ignores the editor padding and catches lost leading keystrokes', () => {
    expect(normalizeInput(`/reply-mode ${zw}\n${zw}\n${zw}`)).toBe('/reply-mode');
    expect(inputHolds(`/reply-mode ${zw}\n${zw}\n${zw}`, '/reply-mode ')).toBe(true);
    const chip = `${zw}\n@[Botmux]Claude\n`;
    expect(inputHolds(`${chip}  /reply-mode ${zw}\n${zw}`, ' /reply-mode ', chip)).toBe(true);
    // Without the chip as lead, the chip is unexpected leading text.
    expect(inputHolds('@[Botmux]Claude /reply-mode', ' /reply-mode ')).toBe(false);
    // CI: the daemon received these.
    expect(inputHolds(`eply-mode new-topic ${zw}`, '/reply-mode new-topic ')).toBe(false);
    expect(inputHolds(
      '2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
      'e2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
    )).toBe(false);
    // Leftovers a clear missed would be sent with the command.
    expect(inputHolds('eply-mode eply-mode /reply-mode', '/reply-mode')).toBe(false);
  });

  it('does not fail a long probe over rendering differences in its middle', () => {
    const probe =
      'e2e-turn1-1792003390393 RECALL_FIRST_MARKER 请立刻调用 botmux send 在本话题里回复一行内容：' +
      '"ACK-e2e-turn1-1792003390393 RECALL <标记>"（尖括号部分替换成那串标记原文，不要加引号）。做完这一步就结束本轮工作。';
    // Probes end in a fixed sentence; any difference sits mid-text.
    const rendered = probe.replace('"ACK', '“ACK').replace('>"', '>”');
    expect(probe.slice(-24)).not.toContain('"');
    expect(inputHolds(`${rendered} ${zw}`, probe)).toBe(true);
  });
});
