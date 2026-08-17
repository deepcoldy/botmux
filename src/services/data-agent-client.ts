export interface DataAgentConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
}

export interface DataAgentQueryInput {
  question: string;
  larkAppId: string;
  requestUserOpenId?: string;
  requestUserUnionId?: string;
}

export interface DataAgentQueryResult {
  handled: boolean;
  replyText?: string;
  promptPrefix?: string;
}

export function resolveDataAgentConfig(env: NodeJS.ProcessEnv = process.env): DataAgentConfig {
  return {
    enabled: (env.BOTMUX_DATA_AGENT_ENABLED ?? 'false').toLowerCase() === 'true',
    baseUrl: (env.BOTMUX_DATA_AGENT_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    timeoutMs: Number(env.BOTMUX_DATA_AGENT_TIMEOUT_MS) || 30_000,
  };
}

export function looksLikeDataAgentQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  const tableHit = [
    'dim_kgp_merchant',
    'dim_kgp_merchant_shop',
  ].some(token => normalized.includes(token))
    || ['商户维度表', '店铺维度表', '店铺表', '店铺编码', '店铺编号'].some(token => text.includes(token));
  const countHit = ['条数', '数量', '多少', 'count'].some(token => normalized.includes(token));
  const sampleHit = ['随机', '抽样', '取样'].some(token => normalized.includes(token));
  const exportHit = ['导出', '下载', '文件', 'excel', 'xlsx', 'csv'].some(token => normalized.includes(token));
  return tableHit && (countHit || sampleHit || exportHit);
}

export async function queryDataAgent(
  input: DataAgentQueryInput,
  cfg: DataAgentConfig = resolveDataAgentConfig(),
): Promise<DataAgentQueryResult> {
  if (!cfg.enabled || !looksLikeDataAgentQuestion(input.question)) {
    return { handled: false };
  }
  if (!input.requestUserOpenId) {
    return {
      handled: true,
      replyText: 'Data MCP 无法确认提问人的飞书 open_id，已拒绝查询。',
    };
  }
  if (!input.requestUserUnionId) {
    return {
      handled: true,
      replyText: 'Data MCP 无法确认提问人的飞书 union_id，已拒绝查询。',
    };
  }

  return {
    handled: false,
    promptPrefix: [
      '<data_agent_context>',
      '兼容说明:',
      '- 以下身份字段仅用于旧 prompt 兼容/诊断，不是正式主链路。',
      '- 正式主链路应为 native MCP + gateway hidden args 注入。',
      `request_user_open_id: ${input.requestUserOpenId}`,
      `request_user_union_id: ${input.requestUserUnionId}`,
      `mcp_base_url: ${cfg.baseUrl}/api/data-mcp`,
      '职责边界:',
      '- 你负责理解用户问题、查询元数据字典、确认表和业务口径、生成 SQL。',
      '- 元数据查询优先走 host-side 命令：`botmux metadata query "<sql>" --json`。',
      '- 元数据查询不要走 Data MCP；最终业务 SQL 才走 Data MCP。',
      '- 正式主链路优先使用 native MCP 工具：`validate_sql_for_user`、`run_query_for_user`。',
      '- 旧的 `/agent/validate-sql`、`/agent/run-query` 仅作兼容/诊断说明，不作为标准主链路。',
      '- 用户要求导出文件时，先根据结果行数判断；row_count <= 100 可直接调用 /exports。',
      '- row_count > 100 时，先提示用户填写飞书审批流；用户反馈审批通过后，再调用 /exports 并传 approval_confirmed=true。',
      '- MCP 负责权限、SQL guard、审计、执行、导出文件和 1 小时本人绑定下载链接。',
      '固定审批流: https://applink.feishu.cn/T98Cu50aXova',
      '</data_agent_context>',
      '',
    ].join('\n'),
  };
}
