/**
 * Unit tests for built-in skill definitions.
 *
 * Run: pnpm vitest run test/builtin-skills.test.ts
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS } from '../src/skills/definitions.js';

describe('built-in botmux-send skill', () => {
  it('teaches heredoc usage for multiline sends', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-send');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("botmux send <<'EOF'");
    expect(skill!.content).toContain('botmux send "第一行\\n第二行"');
    expect(skill!.content).toContain('字面量');
  });
});
