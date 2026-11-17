import { createHash } from 'node:crypto';

export const TRAEX_INITIAL_FIXED_CONTEXT_BUDGET_BYTES = 24 * 1024;
export const TRAEX_STEADY_FIXED_CONTEXT_BUDGET_BYTES = 4 * 1024;

export interface TraexNativeContextReceipt {
  nativeThreadId: string;
  roleDigest: string;
  skillCatalogDigest: string;
  turnId: string;
  status: 'accepted' | 'unknown';
}

/** The write-edge form of one TraeX RPC turn. `content` may omit fixed blocks
 * the native thread already accepted, so it is only valid for the single
 * `turn/start` it was prepared for: never persist, queue or forward it. Every
 * queued/persisted payload stays self-contained, and the RPC write edge
 * prepares it again against the receipt that is current at that moment. */
export interface PreparedTraexNativeContext {
  content: string;
  nativeThreadId: string;
  roleDigest: string;
  skillCatalogDigest: string;
  fixedContextBytes: number;
  budgetBytes: number;
  includedRole: boolean;
  includedSkillCatalog: boolean;
  contextVersion?: {
    nativeThreadId: string;
    roleDigest: string;
    skillCatalogDigest: string;
  };
}

export class TraexContextBudgetError extends Error {
  readonly code = 'traex_fixed_context_budget_exceeded';

  constructor(
    readonly fixedContextBytes: number,
    readonly budgetBytes: number,
  ) {
    super(`TraeX fixed context is ${fixedContextBytes} bytes; budget is ${budgetBytes} bytes`);
    this.name = 'TraexContextBudgetError';
  }
}

const ROLE_BLOCK = /<role(?:\s[^>]*)?>[\s\S]*?<\/role>/;
const PROJECT_GROUP_BLOCK = /<project_group_mode(?:\s[^>]*)?>[\s\S]*?<\/project_group_mode>/;
const SKILL_REFRESH_BLOCK = /<botmux_skills_refresh>[\s\S]*?<\/botmux_skills_refresh>/;
const SKILL_BLOCK = /<botmux_skills(?:\s[^>]*)?>[\s\S]*?<\/botmux_skills>/;
const VARIABLE_BLOCK_START = /<(?:user_message|attachments|mentions|quoted_message|chat_context|shared_group_context|group_history|substitute_trigger)(?:\s|>)|<sender(?:\s|\/)/;
const VARIABLE_BLOCKS = [
  /<user_message>[\s\S]*<\/user_message>/g,
  /<attachments(?:\s[^>]*)?>[\s\S]*<\/attachments>/g,
  /<mentions>[\s\S]*<\/mentions>/g,
  /<quoted_message(?:\s[^>]*)?>[\s\S]*<\/quoted_message>/g,
  /<chat_context(?:\s[^>]*)?>[\s\S]*<\/chat_context>/g,
  /<shared_group_context(?:\s[^>]*)?>[\s\S]*<\/shared_group_context>/g,
  /<group_history(?:\s[^>]*)?>[\s\S]*<\/group_history>/g,
  /<substitute_trigger>[\s\S]*<\/substitute_trigger>/g,
  /<sender(?:\s[^>]*)?\s*\/>/g,
];

function digest(value: string | undefined): string {
  return createHash('sha256').update(value ?? '', 'utf8').digest('hex');
}

function findFixedContextBlock(content: string, pattern: RegExp): string | undefined {
  const variableStart = content.match(VARIABLE_BLOCK_START)?.index;
  if (variableStart === undefined) return undefined;
  const match = content.slice(0, variableStart).match(pattern);
  return match?.index === undefined
    ? undefined
    : content.slice(match.index, match.index + match[0].length);
}

function withoutExactBlock(content: string, block: string | undefined): string {
  if (!block) return content;
  const index = content.indexOf(block);
  if (index < 0) return content;
  let start = index;
  let end = index + block.length;
  if (content.slice(end, end + 2) === '\n\n') end += 2;
  else if (start >= 2 && content.slice(start - 2, start) === '\n\n') start -= 2;
  return content.slice(0, start) + content.slice(end);
}

function fixedContextBytes(content: string): number {
  if (content.match(VARIABLE_BLOCK_START)?.index === undefined) return 0;
  const fixed = VARIABLE_BLOCKS.reduce(
    (remaining, pattern) => remaining.replace(pattern, ''),
    content,
  );
  return Buffer.byteLength(fixed, 'utf8');
}

function enforceMeasuredBudget(measured: number, budgetBytes: number): number {
  if (measured > budgetBytes) throw new TraexContextBudgetError(measured, budgetBytes);
  return measured;
}

function enforceBudget(
  content: string,
  budgetBytes: number,
): number {
  return enforceMeasuredBudget(fixedContextBytes(content), budgetBytes);
}

export function prepareTraexNativeContext(
  content: string,
  nativeThreadId: string,
  receipt?: TraexNativeContextReceipt,
): PreparedTraexNativeContext {
  const roleBlock = findFixedContextBlock(content, ROLE_BLOCK);
  const projectGroupBlock = findFixedContextBlock(content, PROJECT_GROUP_BLOCK);
  const roleContext = [roleBlock, projectGroupBlock].filter(Boolean).join('\n\n');
  const skillCatalogBlock = findFixedContextBlock(content, SKILL_REFRESH_BLOCK)
    ?? findFixedContextBlock(content, SKILL_BLOCK);
  const roleDigest = digest(roleContext);
  const skillCatalogDigest = digest(skillCatalogBlock);
  // Only an accepted receipt proves the thread holds this context. An
  // `unknown` one (turn/start dispatched, outcome unconfirmed) is treated as
  // absent: resending identical fixed blocks is idempotent, while omitting a
  // role/authorization boundary the thread never received is not, and a
  // blocking `unknown` has no event that could ever clear it.
  const sameThreadReceipt = receipt?.nativeThreadId === nativeThreadId && receipt.status === 'accepted'
    ? receipt
    : undefined;

  let preparedContent = content;
  const omitRole = !!roleContext && sameThreadReceipt?.roleDigest === roleDigest;
  const omitSkillCatalog = !!skillCatalogBlock
    && sameThreadReceipt?.skillCatalogDigest === skillCatalogDigest;
  if (omitRole) {
    preparedContent = withoutExactBlock(preparedContent, roleBlock);
    preparedContent = withoutExactBlock(preparedContent, projectGroupBlock);
  }
  if (omitSkillCatalog) preparedContent = withoutExactBlock(preparedContent, skillCatalogBlock);

  const includedRole = !!roleContext && !omitRole;
  const includedSkillCatalog = !!skillCatalogBlock && !omitSkillCatalog;
  const contextChanged = includedRole || includedSkillCatalog;
  const effectiveRoleDigest = roleContext
    ? roleDigest
    : sameThreadReceipt?.roleDigest ?? roleDigest;
  const effectiveSkillCatalogDigest = skillCatalogBlock
    ? skillCatalogDigest
    : sameThreadReceipt?.skillCatalogDigest ?? skillCatalogDigest;
  const budgetBytes = sameThreadReceipt && !contextChanged
    ? TRAEX_STEADY_FIXED_CONTEXT_BUDGET_BYTES
    : TRAEX_INITIAL_FIXED_CONTEXT_BUDGET_BYTES;
  const measuredFixedContextBytes = enforceBudget(preparedContent, budgetBytes);

  return {
    content: preparedContent,
    nativeThreadId,
    roleDigest: effectiveRoleDigest,
    skillCatalogDigest: effectiveSkillCatalogDigest,
    fixedContextBytes: measuredFixedContextBytes,
    budgetBytes,
    includedRole,
    includedSkillCatalog,
    ...(!sameThreadReceipt || contextChanged
      ? {
          contextVersion: {
            nativeThreadId,
            roleDigest: effectiveRoleDigest,
            skillCatalogDigest: effectiveSkillCatalogDigest,
          },
        }
      : {}),
  };
}

export function appendTraexSkillCatalog(
  prepared: PreparedTraexNativeContext,
  skillCatalog: string,
  receipt?: TraexNativeContextReceipt,
  catalogDigest?: string,
): PreparedTraexNativeContext {
  if (!skillCatalog) return prepared;
  const skillCatalogDigest = catalogDigest ?? digest(skillCatalog);
  const sameAccepted = receipt?.nativeThreadId === prepared.nativeThreadId
    && receipt.status === 'accepted';
  const includeSkillCatalog = !sameAccepted
    || receipt.skillCatalogDigest !== skillCatalogDigest;
  const content = includeSkillCatalog
    ? `${prepared.content}\n\n${skillCatalog}`
    : prepared.content;
  const includedRole = prepared.includedRole;
  const includedSkillCatalog = includeSkillCatalog;
  const contextChanged = includedRole || includedSkillCatalog;
  const budgetBytes = sameAccepted && !contextChanged
    ? TRAEX_STEADY_FIXED_CONTEXT_BUDGET_BYTES
    : TRAEX_INITIAL_FIXED_CONTEXT_BUDGET_BYTES;
  const appendedFixedBytes = includeSkillCatalog
    ? Buffer.byteLength(`\n\n${skillCatalog}`, 'utf8')
    : 0;
  const measuredFixedContextBytes = enforceMeasuredBudget(
    fixedContextBytes(prepared.content) + appendedFixedBytes,
    budgetBytes,
  );
  return {
    content,
    nativeThreadId: prepared.nativeThreadId,
    roleDigest: prepared.roleDigest,
    skillCatalogDigest,
    fixedContextBytes: measuredFixedContextBytes,
    budgetBytes,
    includedRole,
    includedSkillCatalog,
    ...(contextChanged
      ? {
          contextVersion: {
            nativeThreadId: prepared.nativeThreadId,
            roleDigest: prepared.roleDigest,
            skillCatalogDigest,
          },
        }
      : {}),
  };
}

export function settleTraexNativeContextReceipt(
  prepared: PreparedTraexNativeContext,
  acceptedTurnId: string,
  status: TraexNativeContextReceipt['status'],
): TraexNativeContextReceipt | undefined {
  if (!prepared.contextVersion) return undefined;
  return { ...prepared.contextVersion, turnId: acceptedTurnId, status };
}
