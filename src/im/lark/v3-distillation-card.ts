/** Safe, proposal-only card for v3 parameter distillation. */

export const V3_DISTILL_ACCEPT_ACTION = 'v3_distill_accept';
export const V3_DISTILL_REJECT_ACTION = 'v3_distill_reject';

const PROPOSAL_ID_RE = /^dp_[0-9a-f]{32}$/;
const NONCE_RE = /^[0-9a-f]{64}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type V3DistillationFieldCategory = 'goal' | 'system_prompt_append' | 'spec_narrative';

export interface V3DistillationFieldCategoryRef {
  category: V3DistillationFieldCategory;
  /** Stable one-based ordinal within this category; never a node id or JSON pointer. */
  ordinal: number;
}

/**
 * Deliberately safe projection of one proposed parameter. Source literals,
 * hashes, JSON pointers, and node ids are not representable in this DTO.
 */
export interface V3DistillationParameterSummary {
  name: string;
  type: 'string';
  required: true;
  hasDefault: false;
  replacementCount: number;
  fieldCategories: readonly V3DistillationFieldCategoryRef[];
}

export interface V3DistillationActionValue {
  action: typeof V3_DISTILL_ACCEPT_ACTION | typeof V3_DISTILL_REJECT_ACTION;
  proposalId: string;
  nonce: string;
}

export interface V3DistillationProposalCardInput {
  proposalId: string;
  nonce: string;
  parameters: readonly V3DistillationParameterSummary[];
}

export function isV3DistillationAction(
  action: unknown,
): action is V3DistillationActionValue['action'] {
  return action === V3_DISTILL_ACCEPT_ACTION || action === V3_DISTILL_REJECT_ACTION;
}

const PARAM_SUMMARY_KEYS = [
  'fieldCategories',
  'hasDefault',
  'name',
  'replacementCount',
  'required',
  'type',
] as const;
const FIELD_CATEGORY_KEYS = ['category', 'ordinal'] as const;
const CARD_INPUT_KEYS = ['nonce', 'parameters', 'proposalId'] as const;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldCategory(value: unknown): value is V3DistillationFieldCategory {
  return value === 'goal' || value === 'system_prompt_append' || value === 'spec_narrative';
}

function normalizeSafeCardInput(input: V3DistillationProposalCardInput): V3DistillationProposalCardInput {
  if (!isRecord(input) || !hasExactKeys(input, CARD_INPUT_KEYS)) {
    throw new Error('参数蒸馏卡片输入不合法');
  }
  const proposalId = input.proposalId;
  const nonce = input.nonce;
  const rawParameters = input.parameters;
  if (
    typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId) ||
    typeof nonce !== 'string' || !NONCE_RE.test(nonce)
  ) {
    throw new Error('参数蒸馏卡片标识不合法');
  }
  if (!Array.isArray(rawParameters)) {
    throw new Error('参数蒸馏卡片参数数量不合法');
  }
  const parameterCount = rawParameters.length;
  if (!Number.isSafeInteger(parameterCount) || parameterCount < 1 || parameterCount > 32) {
    throw new Error('参数蒸馏卡片参数数量不合法');
  }
  const names = new Set<string>();
  const parameters: V3DistillationParameterSummary[] = [];
  for (let i = 0; i < parameterCount; i++) {
    const summary = rawParameters[i] as unknown;
    if (!isRecord(summary) || !hasExactKeys(summary, PARAM_SUMMARY_KEYS)) {
      throw new Error('参数蒸馏卡片参数摘要不合法');
    }
    // Read each untrusted property exactly once, then render only the copied
    // values. A getter/proxy cannot swap a validated name for a secret later.
    const name = summary.name;
    const type = summary.type;
    const required = summary.required;
    const hasDefault = summary.hasDefault;
    const replacementCount = summary.replacementCount;
    const rawFieldCategories = summary.fieldCategories;
    if (
      typeof name !== 'string' ||
      !PARAM_NAME_RE.test(name) ||
      names.has(name) ||
      type !== 'string' ||
      required !== true ||
      hasDefault !== false ||
      !Number.isSafeInteger(replacementCount) ||
      (replacementCount as number) < 1 ||
      (replacementCount as number) > 10_000 ||
      !Array.isArray(rawFieldCategories)
    ) {
      throw new Error('参数蒸馏卡片参数摘要不合法');
    }
    const fieldCount = rawFieldCategories.length;
    if (!Number.isSafeInteger(fieldCount) || fieldCount < 1 || fieldCount > 128) {
      throw new Error('参数蒸馏卡片参数摘要不合法');
    }
    names.add(name);
    const fieldCategories: V3DistillationFieldCategoryRef[] = [];
    for (let j = 0; j < fieldCount; j++) {
      const field = rawFieldCategories[j] as unknown;
      if (
        !isRecord(field) ||
        !hasExactKeys(field, FIELD_CATEGORY_KEYS)
      ) {
        throw new Error('参数蒸馏卡片字段摘要不合法');
      }
      const category = field.category;
      const ordinal = field.ordinal;
      if (
        !isFieldCategory(category) ||
        !Number.isSafeInteger(ordinal) ||
        (ordinal as number) < 1 ||
        (ordinal as number) > 10_000
      ) {
        throw new Error('参数蒸馏卡片字段摘要不合法');
      }
      fieldCategories.push({ category, ordinal: ordinal as number });
    }
    parameters.push({
      name,
      type: 'string',
      required: true,
      hasDefault: false,
      replacementCount: replacementCount as number,
      fieldCategories,
    });
  }
  return { proposalId, nonce, parameters };
}

function categoryLabel(field: V3DistillationFieldCategoryRef): string {
  const category = field.category === 'goal'
    ? '任务目标'
    : field.category === 'system_prompt_append'
      ? '系统补充指令'
      : '流程说明';
  return `${category} #${field.ordinal}`;
}

function actionValue(
  action: V3DistillationActionValue['action'],
  input: V3DistillationProposalCardInput,
): V3DistillationActionValue {
  return { action, proposalId: input.proposalId, nonce: input.nonce };
}

export function buildV3DistillationProposalCard(input: V3DistillationProposalCardInput): string {
  const safe = normalizeSafeCardInput(input);
  const parameterElements = safe.parameters.map((parameter) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**${parameter.name}** · string · 必填 · 无默认值\n` +
        `执行字段：${parameter.fieldCategories.map(categoryLabel).join('、')}；` +
        `DAG/流程说明共替换 ${parameter.replacementCount} 处`,
    },
  }));

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '确认参数化方案' },
    },
    elements: [
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: '这里只展示参数名、类型和替换位置类别，不展示原值、节点标识或内部路径。',
        }],
      },
      ...parameterElements,
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认并保存到本群' },
            type: 'primary',
            value: actionValue(V3_DISTILL_ACCEPT_ACTION, safe),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '放弃' },
            type: 'default',
            value: actionValue(V3_DISTILL_REJECT_ACTION, safe),
          },
        ],
      },
    ],
  });
}

export function buildV3DistillationCommittedCard(input: {
  displayName: string;
  workflowId: string;
  revisionId: string;
}): string {
  if (
    typeof input.displayName !== 'string' || input.displayName.length < 1 || input.displayName.length > 128 ||
    !/^wf_[0-9a-f]{32}$/.test(input.workflowId) || !/^rev_[0-9a-f]{64}$/.test(input.revisionId)
  ) throw new Error('参数蒸馏保存结果不合法');
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '已保存参数化 Workflow' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: input.displayName } },
      { tag: 'note', elements: [{
        tag: 'plain_text',
        content: `workflowId: ${input.workflowId}\nrevision: ${input.revisionId}\nscope: 本群`,
      }] },
    ],
  });
}

export function buildV3DistillationRejectedCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: '已放弃参数化方案' } },
    elements: [{
      tag: 'note',
      elements: [{ tag: 'plain_text', content: '未创建或修改任何 Saved Workflow。' }],
    }],
  });
}

/** Strictly parse the only data that may cross the card callback boundary. */
export function parseV3DistillationActionValue(value: unknown): V3DistillationActionValue | null {
  if (!isRecord(value) || !hasExactKeys(value, ['action', 'nonce', 'proposalId'])) return null;
  const action = value.action;
  const proposalId = value.proposalId;
  const nonce = value.nonce;
  if (!isV3DistillationAction(action)) return null;
  if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  return { action, proposalId, nonce };
}
