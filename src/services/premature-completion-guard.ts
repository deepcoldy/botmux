export const PREMATURE_COMPLETION_ERROR_CODE = 'premature_completion';

export interface PrematureCompletionInput {
  cliId?: string;
  turnId: string;
  requestText?: string;
  finalText?: string;
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  toolActivityObserved?: boolean;
  explicitFinalReplyObserved?: boolean;
  isLocal?: boolean;
  dispatchAttempt?: number;
}

export type PrematureCompletionDecision =
  | { recover: true; errorCode: typeof PREMATURE_COMPLETION_ERROR_CODE }
  | { recover: false };

const EXECUTION_REQUEST_RE = /(?:请|帮我|麻烦你?|直接|现在|立即|彻底|本地)?\s*(?:修复|修改|实现|新增|添加|删除|移除|创建|生成|运行|执行|部署|安装|配置|更新|调整|重构|编写|补充|提交|合并|处理|完成|验证|测试|排查|检查|核对|核查|查看|看看|审查|评审)|\b(?:please\s+)?(?:fix|implement|add|remove|delete|create|generate|run|execute|deploy|install|configure|update|change|refactor|write|test|verify|build|inspect|check|review|audit|investigate)\b/i;
const NO_EXECUTION_RE = /(?:(?:只(?:要|需)?|先)?(?:给|提供|输出|写|列)(?:我)?.{0,16}(?:方案|计划|建议|思路|步骤)|先(?:说|讨论|解释)(?:一下)?.{0,12}(?:方案|计划|建议|思路|步骤)|不要(?:执行|修改|改动|动手|运行|提交|部署|安装|创建|写入|检查|核对|核查|查看|审查|评审)|暂时?别(?:执行|修改|改动|动手|运行|提交|部署|安装|检查|核对|核查|查看|审查|评审)|等(?:我|用户).{0,20}(?:确认|回复|批准))|\bplan only\b|\b(?:only )?(?:give|provide|write|show) (?:me )?(?:a )?.{0,20}plan\b|\b(?:do not|don't|don’t)\s+(?:execute|change|modify|edit|run|deploy|install|write|inspect|check|review|audit|investigate)\b|\bwait (?:for|until).{0,30}(?:approval|confirmation)\b/i;
const INFORMATION_REQUEST_RE = /(?:为什么|为何|是什么|什么原因|能不能|能否|是否|可不可以|可以吗|有没有|怎么做|如何做|如何修复|怎么修复|解释一下|说明一下|告诉我(?:为什么|原因|怎么|如何))|\b(?:why|how (?:do|does|can|should|to)|explain|describe|(?:can|could|would|will) (?:you|this|that|the))\b/i;
const DIRECT_EXECUTION_RE = /(?:请|帮我|麻烦你?|直接|现在|立即|彻底)\s*(?:修复|修改|实现|新增|添加|删除|创建|运行|执行|部署|安装|配置|更新|处理|完成|检查|核对|核查|查看|看看|审查|评审)|\b(?:please\s+|(?:can|could|would) you (?:please )?)(?:fix|implement|add|remove|create|run|execute|deploy|install|configure|update|change|build|inspect|check|review|audit|investigate)\b/i;

const RECOVERY_REQUEST_RE = /^\s*\[BOTMUX_(?:PREMATURE_COMPLETION_)?RECOVERY\](?:\s|$)/;
const FUTURE_WORK_RE = /(?:^|[。！？!?，、,\n]\s*)(?:(?:接下来|下一步|现在|随后|然后)\s*)?(?:我(?:(?:接下来|下一步|现在|随后|然后|这就|马上|立刻)?(?:会|将|要|准备|打算|先|来|去))|让(?:我|咱)(?:先|来|去)?|先(?:从|检查|读取|查看|看看|定位|分析|修改|修复|运行|执行)|接下来(?:会|将|要|先|去)?|下一步(?:会|将|要|先|去)?)|\b(?:i(?:'ll| will|'m going to| am going to)|let me|next,?\s+i(?:'ll| will)|i(?:'ll| will) start by)\b/i;
const COMPLETION_EVIDENCE_RE = /(?:(?:已|已经)(?:完成|修复|修改|实现|添加|删除|创建|运行|执行|部署|安装|配置|更新|验证|测试|处理)|(?:修复|修改|实现|部署|安装|配置|更新|测试|验证)(?:已经|已)?(?:完成|通过|成功)(?!后|以后|之后|再)|(?:修完|搞定|弄好)(?:了)?(?=$|[。！？!?，、,\s]))|\b(?:done|completed|fixed|implemented|updated|created|deployed|installed|successfully (?:fixed|implemented|updated|created|deployed|installed)|tests? (?:all )?pass(?:ed)?|build pass(?:ed)?)\b/i;

function extractRequestText(value: string): string {
  const wrapped = value.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/i)?.[1];
  return (wrapped ?? value)
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/gi, '')
    .replace(/<mentions>[\s\S]*?<\/mentions>/gi, '')
    .replace(/<sender\b[\s\S]*?<\/sender>/gi, '')
    .replace(/<sender\b[^>]*\/>/gi, '')
    .trim();
}

/**
 * Detect the narrow, high-confidence failure shape where TraeX accepted an
 * execution request but closed the native turn after only promising future
 * work. This is deliberately not a general goal-completion judge.
 */
export function shouldRecoverPrematureCompletion(
  input: PrematureCompletionInput,
): PrematureCompletionDecision {
  const eligibleTurnId = input.turnId.startsWith('om_')
    || input.turnId.startsWith('schedule:')
    || input.turnId.startsWith('bmx-recovery-');
  if (input.cliId !== 'traex'
    || !eligibleTurnId
    || input.dispatchAttempt !== undefined
    || input.isLocal === true
    || input.terminalStatus !== 'completed'
    || input.toolActivityObserved === true
    || input.explicitFinalReplyObserved === true) return { recover: false };

  const request = input.requestText ? extractRequestText(input.requestText) : '';
  const finalText = input.finalText?.trim() ?? '';
  if (!request || !finalText || finalText.length > 2_000) return { recover: false };
  if (RECOVERY_REQUEST_RE.test(request)) return { recover: false };
  if (NO_EXECUTION_RE.test(request)) return { recover: false };
  if (INFORMATION_REQUEST_RE.test(request) && !DIRECT_EXECUTION_RE.test(request)) {
    return { recover: false };
  }
  if (!EXECUTION_REQUEST_RE.test(request)
    || !FUTURE_WORK_RE.test(finalText)
    || COMPLETION_EVIDENCE_RE.test(finalText)) return { recover: false };

  return { recover: true, errorCode: PREMATURE_COMPLETION_ERROR_CODE };
}
