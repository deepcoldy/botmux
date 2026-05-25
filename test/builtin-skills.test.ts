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
    expect(history!.content).toContain('--scope ambient');
    expect(history!.content).toContain('thread 外的群聊上下文');
    expect(history!.content).toContain('仅在用户明确需要群聊背景时使用');
    expect(history!.content).toContain('sessionScope=thread');
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

describe('built-in botmux-workflow-create skill', () => {
  it('exists and teaches validate + current workflow binding constraints', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-workflow-create');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('botmux workflow validate');
    expect(skill!.content).toContain('botmux bots list');
    expect(skill!.content).toContain('description');
    expect(skill!.content).toContain('feishu-send');
    expect(skill!.content).toContain('feishu-reply');
    expect(skill!.content).toContain('botmux-schedule');
    expect(skill!.content).toContain('"$ref": "params.<path>"');
    // String template interpolation `${...}` is now supported alongside whole-field $ref —
    // SKILL.md must teach the new syntax so workflow-create LLM uses it instead of writing
    // upstream "planRequest"-style workaround fields.
    expect(skill!.content).toContain('${params.city}');
    expect(skill!.content).toContain('${fetchWeather.output.summary}');
    expect(skill!.content).toContain('整字段');
    expect(skill!.content).toContain('内嵌');
    // The old "no template language" line must be gone so the LLM doesn't keep
    // building "planRequest"-style upstream wrappers.
    expect(skill!.content).not.toContain('当前没有字符串模板语言');
    // workflow.subagent.bot must be larkAppId (cross-daemon stable identifier), not displayName
    expect(skill!.content).toContain('larkAppId');
    expect(skill!.content).toContain('cli_xxxxxxxxxxxxxxxx');
    expect(skill!.content).not.toContain('"bot": "claude-loopy"');
    // workflow file must live at $HOME/.botmux/workflows/, not in arbitrary cwd
    expect(skill!.content).toContain('$HOME/.botmux/workflows/');
    // Params docs must track shared coerceWorkflowParams behavior across CLI + IM.
    expect(skill!.content).toContain('--param-json');
    expect(skill!.content).toContain('未知参数：');
    expect(skill!.content).toContain('缺少必填参数：');
    expect(skill!.content).toContain('必须是 number');
    expect(skill!.content).toContain('必须是 boolean');
    expect(skill!.content).toContain('暂不支持 object / array');
    expect(skill!.content).toContain('object / array');
    expect(skill!.content).toContain('default');
  });
});

describe('botmux-ask skill 退役', () => {
  it('BUILTIN_SKILLS 不再包含 botmux-ask（改由 hook 接管）', () => {
    expect(BUILTIN_SKILLS.find(s => s.name === 'botmux-ask')).toBeUndefined();
  });

  it('RETIRED_SKILL_NAMES 包含 botmux-ask（清理已安装的旧 SKILL.md）', () => {
    expect(RETIRED_SKILL_NAMES).toContain('botmux-ask');
  });
});
