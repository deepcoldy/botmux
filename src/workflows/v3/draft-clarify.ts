/**
 * Dashboard 版需求澄清 (design 2026-11-03 workflow-dashboard-orchestration
 * §4.2, E1): the prompt the orchestrating bot's headless clarify session gets,
 * and the parser for what it answers.
 *
 * Same rules as the botmux-workflow skill's grill (one question at a time with
 * a recommended answer, collect every node's five fields, the user may say
 * 「够了」at any time), with two differences:
 *   - no `botmux send` / `botmux ask`: the question is the turn's final output;
 *   - no `botmux workflow` command at all: the daemon advances the draft. When
 *     the spec is ready the model writes it (spec.md format) between
 *     `<botmux-spec>` and `</botmux-spec>`; the daemon reads it from there.
 *
 * Output conventions the Dashboard renders (D3):
 *
 *   ```botmux-question
 *   {"question":"…","options":["A","B"],"recommended":"A"}
 *   ```
 *   → option buttons (a click is sent as the next turn); anything else is
 *   plain text. The block's info string is not `json`, so it can never be
 *   mistaken for the spec's canonical ```json block.
 *
 * This text is sent as turn content to that one session only; it is not a
 * skill and is never injected into other sessions.
 */

import type { WorkflowDraftQuestion, WorkflowDraftTurn } from './draft-store.js';

export const DRAFT_SPEC_OPEN = '<botmux-spec>';
export const DRAFT_SPEC_CLOSE = '</botmux-spec>';
export const DRAFT_QUESTION_INFO = 'botmux-question';

const SPEC_SCHEMA_EXAMPLE = `{
  "schemaVersion": 1,
  "runId": "<runId>",
  "title": "<一句话标题>",
  "requirement": "<收敛后的清晰需求>",
  "acceptance": "<整体验收标准>",
  "nonGoals": ["<明确不做的>"],
  "nodes": [
    {
      "sketchId": "research",
      "goal": "调研 X/Y/Z 的定价与功能，写成 facts.md",
      "input_needs": [],
      "expected_outputs": ["facts.md"],
      "acceptance": "每家含定价档+功能矩阵",
      "risk_gate": false,
      "unknowns": []
    }
  ]
}`;

function rules(runId: string): string {
  return [
    '你在 botmux Dashboard 上帮用户把一个模糊的复合目标澄清成可编排的工作流需求（spec）。用户在网页的对话面板里和你一问一答，你这一轮的最终输出就是用户看到的回复。',
    '',
    '## 怎么问',
    '- 一次只问一个问题，并给出你的推荐答案（不要开放式地问「你想怎样」）。',
    '- 沿决策树走，先父决策再子决策；能从代码或文件查到的别问，直接查。',
    '- 目标：为每个预想节点凑齐 goal / input_needs / expected_outputs / acceptance / risk_gate 五件套，凑不齐就继续问。五件套是上限不是下限，能合并的问题合并。',
    '- 逃生阀：用户随时可以说「够了 / 用默认 / 别问了」——立即收尾，用推荐默认填满缺口，把没定的写进该节点 unknowns。',
    `- 每个问题在回复末尾附一个问题块，页面会把它渲染成选项按钮（选项可省略，推荐答案应是选项之一）：\n\`\`\`${DRAFT_QUESTION_INFO}\n{"question":"<问题>","options":["<选项1>","<选项2>"],"recommended":"<推荐答案>"}\n\`\`\``,
    '',
    '## 绝对不要',
    '- 不要运行 `botmux send`、`botmux ask` 或任何 `botmux workflow` 命令；草稿的状态由系统推进，你只负责对话和产出 spec 文本。',
    '- 不要开始执行任务本身，不要编排流程图（那是之后 Architect 的活）。',
    '',
    '## 定稿',
    `需求收敛（或用户说够了）时，在回复里输出完整 spec，放在单独成行的 ${DRAFT_SPEC_OPEN} 与 ${DRAFT_SPEC_CLOSE} 之间。spec 的格式与 spec.md 相同：人读叙事（## 需求 / ## 决策树 / ## 验收标准 / ## 非目标）+ **唯一一个** \`\`\`json 代码块（canonical Spec），schema 如下：`,
    '```json',
    SPEC_SCHEMA_EXAMPLE.replace('<runId>', runId),
    '```',
    '字段铁律：',
    '- input_needs 是自由文本，描述这步需要什么信息/产物，绝不要写成上游 sketchId 列表（画依赖边是 Architect 的活）。',
    '- risk_gate: true 表示这步执行期要人工审批（例如对外发送）。',
    '- unknowns 放没跟用户定死、用了默认的点。',
    '- 用户明确点名某步由哪个 Bot 做时，在该节点加 "assignee": "<Bot 名或 larkAppId>"；没点名就不写。',
    `- runId 固定写 ${runId}。`,
    '系统校验 spec 不通过时，会把问题列表作为下一轮发给你，按问题改好后重新输出完整 spec。',
  ].join('\n');
}

/** First turn of a draft's clarify session. */
export function buildDraftClarifyKickoff(input: { runId: string; goal: string }): string {
  return [
    rules(input.runId),
    '',
    '## 用户的目标',
    input.goal.trim(),
    '',
    '现在开始：先用一句话复述你理解的目标，然后问第一个问题。',
  ].join('\n');
}

const RESUME_TURNS = 8;
const RESUME_TURN_CHARS = 4_000;

/**
 * First turn of a replacement session after the old one could not be resumed
 * (§9 「会话已断开」→「继续」): the same rules, the goal, the spec so far and
 * the last few turns.
 */
export function buildDraftClarifyResume(input: {
  runId: string;
  goal: string;
  specMarkdown?: string;
  turns: readonly WorkflowDraftTurn[];
}): string {
  const recent = input.turns.filter((turn) => turn.role !== 'system').slice(-RESUME_TURNS);
  const transcript = recent.map((turn) => {
    const text = turn.text.length > RESUME_TURN_CHARS ? `${turn.text.slice(0, RESUME_TURN_CHARS)}…` : turn.text;
    return `### ${turn.role === 'user' ? '用户' : '你'}\n${text}`;
  });
  return [
    rules(input.runId),
    '',
    '## 用户的目标',
    input.goal.trim(),
    '',
    '之前的澄清会话断开了，下面是已有的上下文，接着往下问，不要从头再来。',
    ...(input.specMarkdown?.trim()
      ? ['', '## 已有的 spec 草稿', input.specMarkdown.trim()]
      : []),
    ...(transcript.length > 0 ? ['', '## 最近几轮对话', ...transcript] : []),
    '',
    '现在：用一句话说明进度，然后问下一个问题（或者需求已经够了就直接给出 spec）。',
  ].join('\n');
}

/** The problems of a spec that did not validate, as the next turn. */
export function buildDraftSpecProblemsTurn(problems: readonly string[]): string {
  return [
    `你给出的 spec 没有通过校验，请按下面的问题修改后，重新输出完整 spec（放在 ${DRAFT_SPEC_OPEN} 与 ${DRAFT_SPEC_CLOSE} 之间）：`,
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}

export interface ParsedClarifyOutput {
  /** The output with the question block removed (the spec stays visible). */
  text: string;
  question?: WorkflowDraftQuestion;
  /** spec.md content between the markers (trimmed), when present. */
  specMarkdown?: string;
}

const QUESTION_BLOCK_RE = new RegExp('```' + DRAFT_QUESTION_INFO + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g');

function parseQuestion(raw: string): WorkflowDraftQuestion | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const question = typeof record.question === 'string' ? record.question.trim().slice(0, 4000) : '';
  if (!question) return undefined;
  const options = Array.isArray(record.options)
    ? [...new Set(record.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim().slice(0, 1000))
        .filter(Boolean))].slice(0, 20)
    : [];
  const recommended = typeof record.recommended === 'string' ? record.recommended.trim().slice(0, 1000) : '';
  return { question, options, ...(recommended ? { recommended } : {}) };
}

/**
 * Split one turn's final output: the LAST question block (earlier ones are
 * dropped with it, a turn asks one question), and the LAST complete
 * `<botmux-spec>` section.
 */
export function parseDraftClarifyOutput(content: string): ParsedClarifyOutput {
  let question: WorkflowDraftQuestion | undefined;
  const text = content.replace(QUESTION_BLOCK_RE, (_match, body: string) => {
    question = parseQuestion(body) ?? question;
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  let specMarkdown: string | undefined;
  const close = content.lastIndexOf(DRAFT_SPEC_CLOSE);
  if (close >= 0) {
    const open = content.lastIndexOf(DRAFT_SPEC_OPEN, close);
    if (open >= 0) {
      const body = content.slice(open + DRAFT_SPEC_OPEN.length, close).trim();
      if (body) specMarkdown = body;
    }
  }
  return { text, ...(question ? { question } : {}), ...(specMarkdown ? { specMarkdown } : {}) };
}
