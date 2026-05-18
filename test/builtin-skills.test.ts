/**
 * Unit tests for built-in skill definitions.
 *
 * Run: pnpm vitest run test/builtin-skills.test.ts
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES } from '../src/skills/definitions.js';

describe('built-in botmux-send skill', () => {
  it('teaches heredoc usage for multiline sends', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-send');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("botmux send <<'EOF'");
    expect(skill!.content).toContain('botmux send "第一行\\n第二行"');
    expect(skill!.content).toContain('字面量');
  });
});

describe('built-in botmux-history skill', () => {
  it('replaces botmux-thread-messages and documents普通群 / 话题群 dual behavior', () => {
    const history = BUILTIN_SKILLS.find(s => s.name === 'botmux-history');
    expect(history).toBeDefined();
    expect(history!.content).toContain('botmux history');
    // Description must mention 普通群 so普通群 bots actually trigger the skill.
    expect(history!.content).toContain('普通群');
    expect(history!.content).toContain('scope=chat');
  });

  it('retires the old botmux-thread-messages name', () => {
    expect(BUILTIN_SKILLS.find(s => s.name === 'botmux-thread-messages')).toBeUndefined();
    expect(RETIRED_SKILL_NAMES).toContain('botmux-thread-messages');
  });
});

describe('built-in botmux-quoted skill', () => {
  it('exists and references the daemon-injected quote-prefix marker', () => {
    const quoted = BUILTIN_SKILLS.find(s => s.name === 'botmux-quoted');
    expect(quoted).toBeDefined();
    expect(quoted!.content).toContain('botmux quoted');
    expect(quoted!.content).toContain('用户引用了消息');
  });
});
