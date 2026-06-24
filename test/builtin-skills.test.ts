/**
 * Unit tests for built-in skill definitions.
 *
 * Run: pnpm vitest run test/builtin-skills.test.ts
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, RETIRED_SKILL_NAMES, WHITEBOARD_SKILL, WHITEBOARD_SKILL_NAME } from '../src/skills/definitions.js';

describe('built-in botmux-send skill', () => {
  it('teaches safe multiline sends across Unix and Windows shells', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-send');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("botmux send <<'EOF'");
    expect(skill!.content).toContain('Windows/PowerShell');
    expect(skill!.content).toContain('--content-file');
    expect(skill!.content).toContain('Set-Content -LiteralPath $msg -Encoding utf8');
    expect(skill!.content).toContain('不要把中文直接通过 here-string');
  });

  it('warns that mention-back/no-mention are switches without values', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-send');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('--mention-back');
    expect(skill!.content).toContain('--no-mention');
    expect(skill!.content).toContain('是开关，后面不跟任何参数');
    expect(skill!.content).toContain('--mention <open_id:名字>');
    expect(skill!.content).toContain('--content-file > 位置参数 > stdin');
    expect(skill!.content).toContain('多行正文推荐只放在 heredoc/stdin 中');
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

describe('built-in botmux-bots skill (collaboration roster)', () => {
  it('documents the enhanced roster fields and the mentionable rule', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-bots');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('capability');
    expect(skill!.content).toContain('mentionable');
    expect(skill!.content).toContain('hasTeamRole');
    expect(skill!.content).toContain('/introduce');
    expect(skill!.content).toContain('botmux-handoff');
  });
});

describe('built-in botmux-handoff skill', () => {
  it('is registered and teaches the 5-part structured handoff', () => {
    const skill = BUILTIN_SKILLS.find(s => s.name === 'botmux-handoff');
    expect(skill).toBeDefined();
    expect(skill!.content).toContain('交给谁');
    expect(skill!.content).toContain('当前结论');
    expect(skill!.content).toContain('相关上下文');
    expect(skill!.content).toContain('期望下一步');
    expect(skill!.content).toContain('完成标准');
    expect(skill!.content).toContain('botmux bots list');
    expect(skill!.content).toContain('mentionable');
    expect(skill!.content).toContain('/introduce');
    expect(skill!.content).toContain('botmux send --mention');
  });
});

describe('built-in botmux-whiteboard skill', () => {
  it('is NOT in BUILTIN_SKILLS — installed conditionally on the whiteboard toggle', () => {
    // The whiteboard feature is off by default, so its skill must not be written
    // unconditionally. It is materialised only when enabled, via
    // ensureWhiteboardSkill (see ensure-whiteboard-skill.test.ts).
    expect(BUILTIN_SKILLS.find(s => s.name === WHITEBOARD_SKILL_NAME)).toBeUndefined();
    expect(WHITEBOARD_SKILL_NAME).toBe('botmux-whiteboard');
  });

  it('teaches disabled/default-safe usage', () => {
    expect(WHITEBOARD_SKILL).toContain('botmux whiteboard status');
    expect(WHITEBOARD_SKILL).toContain('默认关闭');
    expect(WHITEBOARD_SKILL).toContain('botmux whiteboard update');
    expect(WHITEBOARD_SKILL).not.toContain('botmux whiteboard post');
    expect(WHITEBOARD_SKILL).toContain('write --yes');
    expect(WHITEBOARD_SKILL).toContain('不要写');
    expect(WHITEBOARD_SKILL).toContain('botmux send');
  });
});

describe('botmux-worker-budget skill retired (moved to per-bot dashboard field)', () => {
  it('is no longer a standalone skill and is pruned on upgrade', () => {
    expect(BUILTIN_SKILLS.find(s => s.name === 'botmux-worker-budget')).toBeUndefined();
    expect(RETIRED_SKILL_NAMES).toContain('botmux-worker-budget');
  });
});

describe('agent raise-hand folded into botmux-send (--attention)', () => {
  it('botmux-needs-help is retired, not a standalone skill', () => {
    expect(BUILTIN_SKILLS.find(s => s.name === 'botmux-needs-help')).toBeUndefined();
    expect(RETIRED_SKILL_NAMES).toContain('botmux-needs-help');
  });

  it('botmux-send description mentions --attention so a blocked agent discovers it', () => {
    const send = BUILTIN_SKILLS.find(s => s.name === 'botmux-send');
    expect(send).toBeDefined();
    // Skills are matched by DESCRIPTION — the blocked-scenario trigger must live
    // in the frontmatter, or a stuck agent won't realize send has --attention.
    const fm = send!.content.split('---')[1] ?? '';
    expect(fm).toContain('--attention');
    expect(fm).toMatch(/硬阻碍|需要人|授权/);
  });

  it('botmux-send body teaches --attention usage + abuse boundaries', () => {
    const send = BUILTIN_SKILLS.find(s => s.name === 'botmux-send')!;
    expect(send.content).toContain('botmux send --attention');
    expect(send.content).toContain('--attention=decision');
    // non-blocking + auto-clear contract, and steer to ask for option-choices
    expect(send.content).toContain('非阻塞');
    expect(send.content).toContain('自动撤下');
    expect(send.content).toContain('botmux ask');
    // guards documented: not with --top-level/--chat-id/--into
    expect(send.content).toContain('--top-level');
  });
});

describe('botmux-ask skill 条件兜底（hook 优先 + 非 hook CLI 保留）', () => {
  it('不在 BUILTIN_SKILLS（不再无条件装到所有 CLI）', () => {
    expect(BUILTIN_SKILLS.find(s => s.name === 'botmux-ask')).toBeUndefined();
  });

  it('不在 RETIRED_SKILL_NAMES（改为按 CLI 条件管理，非全量退役）', () => {
    expect(RETIRED_SKILL_NAMES).not.toContain('botmux-ask');
  });
});
