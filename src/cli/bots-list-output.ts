import type { ChatBotMember } from '../im/lark/client.js';

export type BotInfoEntryForList = {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
  cliId: string;
};

export type BotCollaborationFacts = {
  workspaceSource: 'default' | 'oncall' | 'unknown';
  mentionMode: 'always' | 'topic' | 'never' | 'ambient';
  replyMode: 'chat' | 'chat-topic' | 'new-topic' | 'shared';
  transport: boolean;
};

export type BotCollaborationFactsByAppId = Readonly<Record<string, BotCollaborationFacts>>;

export type BotListOutputEntry = {
  /** Lark display name in the current chat. Good for humans, not stable for workflows. */
  name: string;
  openId: string;
  isSelf: boolean;
  source: 'configured' | 'introduce';
  /** Stable bot id to use in workflow `subagent.bot` fields. Empty for external observed bots. */
  larkAppId: string;
  /** Alias for workflow authors. Equal to larkAppId when locally configured. */
  workflowBot: string | null;
  /** Short capability label (team-level), for picking who to hand off to. */
  capability: string | null;
  /** Whether this bot has a team-level role registered. */
  hasTeamRole: boolean;
  /** Whether YOU (the listing bot) can reliably @-mention it from here. */
  mentionable: boolean;
  /** How the @-mention handle was resolved. */
  mentionSource: 'cross-ref' | 'self' | 'observed' | 'fallback';
  /** Side-effect-free preflight hints for composing `botmux dispatch`. */
  dispatch: {
    /** Dispatch wakes the target with an @; `mentionable` says whether this openId is reliable. */
    trigger: 'mention';
    workspace: 'required' | 'optional' | 'none' | 'unknown';
  };
  /** Evidence available to an orchestrator before dispatching work to this bot. */
  collaboration: {
    reachability: 'ready' | 'needs-introduce' | 'offline' | 'unknown';
    workspace: {
      requirement: 'required' | 'optional' | 'none' | 'unknown';
      source: 'default' | 'oncall' | 'inherited' | 'explicit' | 'none' | 'unknown';
    };
    authorization: {
      talk: 'ready' | 'preflight-required' | 'unknown';
      operate: boolean | 'unknown';
    };
    session: {
      mentionMode: 'always' | 'topic' | 'never' | 'ambient' | 'unknown';
      replyMode: 'chat' | 'chat-topic' | 'new-topic' | 'shared' | 'unknown';
    };
    runtime: {
      transport: boolean | 'unknown';
      deployment: 'local' | 'remote' | 'unknown';
      stale: boolean | 'unknown';
    };
  };
};

export const collaborationHelp = {
  general: 'unknown 表示当前命令没有足够证据，不等于不可用；群成员关系、本地配置和发送成功也不能单独证明目标在线或任务完成。',
  fields: {
    reachability: {
      description: '当前 Bot 是否有足够证据被可靠寻址。',
      values: {
        ready: '已有当前群的可靠 @ 句柄，可以直接寻址；不代表目标运行时在线。',
        'needs-introduce': '已识别配置中的 Bot，但 @ 句柄不可靠；先完成 /introduce 再依赖 @ 派发。',
        offline: '已有权威离线证据；恢复后再派发。',
        unknown: '缺少当前群的可靠寻址证据；先刷新花名册或完成 /introduce，不能据此判定离线。',
      },
    },
    'workspace.requirement': {
      description: '派发任务时是否需要指定仓库或工作区。',
      values: {
        required: '必须显式提供工作区；缺少仓库时不要派发。',
        optional: '工作区可省略；代码任务仍应在需要时明确指定仓库。',
        none: '该 Bot 的任务不需要工作区。',
        unknown: '能力声明没有给出要求；派发前先确认，不能假定当前目录可用。',
      },
    },
    'workspace.source': {
      description: '目标创建会话时可用的工作区配置候选来源；目录校验或会话继承可能改变最终 cwd。',
      values: {
        default: '已配置目标 Bot 的默认工作区候选；不代表最终 cwd。',
        oncall: '当前群命中 OnCall 工作区候选；不代表最终 cwd。',
        inherited: '继承既有会话或话题的工作区。',
        explicit: '使用派发时显式指定的工作区。',
        none: '不需要工作区。',
        unknown: '当前输出没有 cwd 来源证据；不要猜测目标目录。',
      },
    },
    'authorization.talk': {
      description: '是否具备普通 Bot 间对话所需的授权证据。',
      values: {
        ready: '已有对话授权，可以直接交互。',
        'preflight-required': '用稳定 --bot-app 派发；发送前会建立并回读 talk-only 授权。',
        unknown: '没有足够对话授权证据；先确认稳定目标和对话信任链路。',
      },
    },
    'authorization.operate': {
      description: '是否有执行 /repo、/restart 等管理动作的授权证据；与普通对话授权分开判断。',
      values: {
        true: '已有 operate 授权证据，可以执行管理动作。',
        false: '本次 talk-only preflight 不授予 operate；/repo、/restart 等管理动作仍需单独授权。',
        unknown: '当前命令没有 operate 授权证据；不要按 true 处理。',
      },
    },
    'session.mentionMode': {
      description: '目标 Bot 在普通群中何时要求 @ 才会响应；不描述私聊或话题群策略。',
      values: {
        always: '普通群内始终需要 @ 目标 Bot，包括 shared 话题内的续话。',
        topic: '普通群顶层需要 @；shared 话题内后续非 @ 消息可继续唤起。',
        never: '普通群内不需要 @ 即可唤起。',
        ambient: '普通群内可免 @ 观察消息，但消息明确指向其他成员时保持安静。',
        unknown: '没有权威普通群配置；派发时保守地使用明确寻址。',
      },
    },
    'session.replyMode': {
      description: '目标 Bot 在普通群中的回复会落在哪种会话或话题上下文；不描述私聊或话题群策略。',
      values: {
        chat: '普通群内复用群级会话，原生话题也折叠到同一会话。',
        'chat-topic': '普通群顶层复用 chat-scope session；群内原生话题各自使用独立会话。',
        'new-topic': '普通群顶层派发后新建独立话题，应在新话题跟进结果。',
        shared: '普通群回复展示在话题中，但复用群级 chat-scope session 和 cwd。',
        unknown: '没有权威普通群路由配置；不要假定回复位置或上下文会被继承。',
      },
    },
    'runtime.transport': {
      description: '目标 Bot 的配置是否具备飞书 transport 能力；该字段不是在线健康状态。',
      values: {
        true: '配置允许飞书 transport；不证明 daemon 或连接在线。',
        false: 'apiOnly 配置明确不具备飞书 transport。',
        unknown: '当前进程读不到权威 BotConfig；群成员关系或 Lark API 成功不能替代配置证据。',
      },
    },
    'runtime.deployment': {
      description: '目标 Bot 的部署归属；该字段不表示在线状态。',
      values: {
        local: '目标 App 在当前 botmux 主机有配置；仍需单独判断运行时健康。',
        remote: '目标由远端部署管理；派发时需要保留远端回报和路径边界。',
        unknown: '当前输出无法确定部署归属。',
      },
    },
    'runtime.stale': {
      description: '已有运行时健康证据是否过期。',
      values: {
        true: '健康证据已过期；派发前刷新状态。',
        false: '有近期权威健康证据。',
        unknown: '没有健康时间戳或探针证据；不能据此判断在线或离线。',
      },
    },
  },
} as const;

function dispatchGuide(capability: string | null | undefined): BotListOutputEntry['dispatch'] {
  const workspace = capability?.match(/\bworkspace\s*:\s*(required|optional|none)\b/i)?.[1]?.toLowerCase();
  return {
    trigger: 'mention',
    workspace: workspace === 'required' || workspace === 'optional' || workspace === 'none'
      ? workspace
      : 'unknown',
  };
}

function collaborationGuide(
  row: Pick<BotListOutputEntry, 'source' | 'larkAppId' | 'isSelf' | 'mentionable' | 'dispatch'>,
  live: boolean,
  facts: BotCollaborationFacts | undefined,
): BotListOutputEntry['collaboration'] {
  // A "stable peer" is a locally-configured bot we can preflight a talk-only
  // grant against. Gate on source==='configured' explicitly, not just a
  // non-empty larkAppId: today the sole producers guarantee introduce rows
  // carry larkAppId='' (so non-empty ⇒ configured), but talk/operate promise a
  // "--bot-app" dispatch that REQUIRES local config — so we encode that
  // invariant here rather than relying on it. deployment already gates the same
  // way; this keeps a future introduce producer carrying a remote app id from
  // silently flipping talk to preflight-required.
  const stablePeer = live && row.larkAppId !== '' && row.source === 'configured' && !row.isSelf;
  return {
    reachability: live
      ? (row.mentionable ? 'ready' : row.source === 'configured' ? 'needs-introduce' : 'unknown')
      : 'unknown',
    workspace: {
      requirement: row.dispatch.workspace,
      source: row.dispatch.workspace === 'none' ? 'none' : facts?.workspaceSource ?? 'unknown',
    },
    authorization: {
      talk: stablePeer ? 'preflight-required' : 'unknown',
      operate: stablePeer ? false : 'unknown',
    },
    session: {
      mentionMode: facts?.mentionMode ?? 'unknown',
      replyMode: facts?.replyMode ?? 'unknown',
    },
    runtime: {
      transport: facts?.transport ?? 'unknown',
      deployment: row.larkAppId !== '' && ((live && row.source === 'configured') || facts !== undefined)
        ? 'local'
        : 'unknown',
      stale: 'unknown',
    },
  };
}

export function formatChatBotsForCli(
  chatBots: ChatBotMember[],
  currentLarkAppId: string,
  factsByAppId: BotCollaborationFactsByAppId = {},
): BotListOutputEntry[] {
  return chatBots.map((cb) => {
    const row = {
      name: cb.displayName,
      openId: cb.openId,
      isSelf: cb.larkAppId === currentLarkAppId,
      source: cb.source,
      larkAppId: cb.larkAppId,
      workflowBot: cb.larkAppId || null,
      capability: cb.capability ?? null,
      hasTeamRole: cb.hasTeamRole,
      mentionable: cb.mentionable,
      mentionSource: cb.mentionSource,
      dispatch: dispatchGuide(cb.capability),
    } satisfies Omit<BotListOutputEntry, 'collaboration'>;
    return { ...row, collaboration: collaborationGuide(row, true, factsByAppId[row.larkAppId]) };
  });
}

export function formatBotInfoEntriesForCli(
  botEntries: BotInfoEntryForList[],
  currentLarkAppId: string,
  factsByAppId: BotCollaborationFactsByAppId = {},
): BotListOutputEntry[] {
  return botEntries
    .filter((b) => b.botOpenId)
    .map((b) => {
      const row = {
        name: b.botName ?? b.cliId,
        openId: b.botOpenId!,
        isSelf: b.larkAppId === currentLarkAppId,
        source: 'configured' as const,
        larkAppId: b.larkAppId,
        workflowBot: b.larkAppId,
        // Local fallback path (no live chat query): we only know self reliably.
        capability: null,
        hasTeamRole: false,
        mentionable: b.larkAppId === currentLarkAppId,
        mentionSource: (b.larkAppId === currentLarkAppId ? 'self' : 'fallback') as 'self' | 'fallback',
        dispatch: dispatchGuide(null),
      } satisfies Omit<BotListOutputEntry, 'collaboration'>;
      return { ...row, collaboration: collaborationGuide(row, false, factsByAppId[row.larkAppId]) };
    });
}
