/**
 * IM / card 写 Bot 配置时的「由 Agent 统一」提示。
 *
 * Dashboard 的 Bot 页对 Agent 托管分组整块加锁，但 `/botconfig set`、配置卡片的文本
 * 子卡直接走 applyConfigField 写 bots.json，不经过那把锁。写入本身照常生效（下次会话
 * 启动 / 重启就用新值），只是下次在 Agent 页保存、关联或点同步时会被改回 Agent 的值。
 * 这里只负责查出「哪个 Agent 管着这个字段」，让回复里说清楚；不拦截写入。
 *
 * agents.json 归 Dashboard 进程读写，daemon 这里只读；读失败（文件损坏等）视为
 * 「不确定」，不加提示——提示是锦上添花，不能让配置写入因此失败。
 */
import type { AgentProfilesDoc, AgentSection } from '../dashboard/agent-profiles-model.js';
import { defaultAgentProfilesPath, readAgentProfiles } from '../dashboard/agent-profiles-store.js';
import { t, type Locale } from '../i18n/index.js';

/** /botconfig 字段 key → Agent 下发它的分组（与 agentPushRequests 写入的字段一致）。 */
const CONFIG_KEY_AGENT_SECTION: Readonly<Record<string, AgentSection>> = {
  cli: 'exec',
  model: 'exec',
  reasoningEffort: 'exec',
  defaultWorkingDir: 'workspace',
  backendType: 'backend',
  startupCommands: 'startup',
  promptInjection: 'promptInjection',
};

/** 管着 `larkAppId` 的 `fieldKey` 的 Agent 名称；不归 Agent 管或无法判断时返回 null。 */
export async function agentManagingConfigField(
  larkAppId: string,
  fieldKey: string,
  read: () => Promise<AgentProfilesDoc> = () => readAgentProfiles(defaultAgentProfilesPath()),
): Promise<string | null> {
  const section = CONFIG_KEY_AGENT_SECTION[fieldKey];
  if (!section) return null;
  let doc: AgentProfilesDoc;
  try {
    doc = await read();
  } catch {
    return null;
  }
  const agentId = doc.links[larkAppId];
  const agent = agentId ? doc.agents.find(candidate => candidate.id === agentId) : undefined;
  if (!agent || agent[section] === undefined) return null;
  return agent.name;
}

/** 回复 / toast 尾注（含前导换行）；字段不归 Agent 管时为空串。 */
export async function agentManagedNoteSuffix(larkAppId: string, fieldKey: string, loc: Locale): Promise<string> {
  const agent = await agentManagingConfigField(larkAppId, fieldKey);
  return agent ? `\n${t('cmd.config.agent_managed_note', { agent }, loc)}` : '';
}
