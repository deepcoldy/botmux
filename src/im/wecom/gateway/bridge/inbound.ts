/**
 * Inbound message handling: ACL and grant requests, de-duplication, the native
 * command set, and admission of a new task with its frozen TriggerRequest.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { createHash } from 'node:crypto';
import { nativeWecomCommand } from '../native-commands.js';
import { wecomAskText, type NativeAskCore } from '../native-ask.js';
import { enqueueWecomFeedbackEvent } from '../native-feedback.js';
import {
  platformReceive,
  wecomFeedbackPolicy,
  wecomObservedSummary,
} from '../native-platform.js';
import { WECOM_DEFAULT_TALK_COMMANDS } from '../../config/native-core-config.js';
import {
  nativeRequestGrant,
  nativeApproveRequest,
  nativeCanApprove,
  nativeScope,
  nativeGrant,
  nativeGrantKey,
  nativePolicyRevision,
  nativeReserve,
} from '../native-core.js';
import {
  scanWecomRepositories,
  wecomRepositoryListing,
  wecomRepositoryMatches,
  wecomRepositoryStillValid,
  type WecomRepository,
} from '../native-repos.js';
import {
  isCommandTriggerChat,
  reservedCommandKind,
  renderCommandTriggerPrompt,
  commandTriggerArgs,
} from '../../../../services/command-trigger.js';
import { turnRepository, wecomTurnEnvelope, wecomTurnRequest } from './turn-request.js';
import { taskCardActionsExpired } from './card-events.js';
import { isSlashSessionGone } from '../core-client.js';
import type { WecomInboundMessage, WecomTemplateCard } from '../../protocol/types.js';
import type { WecomAdmissionOutcome } from '../../contract/dashboard-dto.js';
import type { Task, WecomBridgePolicy } from './types.js';
import type { WecomBridge } from '../bridge.js';

export function admission(this: WecomBridge, outcome: WecomAdmissionOutcome, message: WecomInboundMessage): void {
  try {
    const observation = this.options.onAdmission?.({ outcome, chatType: message.chatType });
    if (observation) {
      void Promise.resolve(observation).catch(() => {});
    }
  } catch { /* observability must never change admission */ }
}

/** What every step of one inbound message's handling works from. */
interface InboundContext {
  message: WecomInboundMessage;
  capability: 'operate' | 'talk';
  /** The logical route (session key) of the message. */
  route: string;
  /** The task key of the message (its msgid under this bot). */
  key: string;
  /** The route's task still in progress, if any. */
  active: Task | undefined;
  /** The message text, trimmed. */
  text: string;
  /** The shared command the gateway answers itself, when the text is exactly one. */
  command: string | undefined;
  /** The first word of the text, lower-cased. */
  slashName: string;
}

/** The text a new turn carries, and what it was made from. */
interface TurnText {
  commandTrigger: NonNullable<WecomBridgePolicy['commandTriggers']>['commands'][number] | undefined;
  summary: ReturnType<typeof wecomObservedSummary> | undefined;
  promptText: string;
}

/**
 * A command the gateway answers itself. `when` decides from the message alone
 * (nothing is awaited); `handle` resolves false when the message turned out not
 * to be the command's after all, and the next one is tried.
 */
interface InboundCommand {
  when(this: WecomBridge, ctx: InboundContext): boolean;
  handle(this: WecomBridge, ctx: InboundContext): Promise<boolean>;
}

const GRANT_COMMAND = /^\/(grant|revoke|grant-approve)(?:\s+([\s\S]+))?$/;
const FEEDBACK_COMMENT = /^\/feedback ([a-f0-9]{64}-final) ([\s\S]+)$/;

/** The task key of a message: its msgid under this bot. */
function messageKey(bridge: WecomBridge, message: WecomInboundMessage): string {
  return createHash('sha256').update(JSON.stringify([bridge.options.botId, message.messageId])).digest('hex');
}

export function receive(this: WecomBridge, message: WecomInboundMessage): Promise<void> {
  stopBesideTheLane.call(this, message);
  return this.enqueue(async () => {
    if (this.halted) {
      this.admission('halted', message);
      return;
    }
    const capability = this.capability(message, false);
    if (capability === 'denied') {
      this.admission('denied', message);
      await requestTalkGrant.call(this, message);
      return;
    }
    const ctx = markSeen.call(this, message, capability);
    if (!ctx) {
      return;
    }
    // Tried in this order; the order is part of the behaviour (a text /ask
    // answer before /help, the talk-permission gate after /feedback).
    for (const command of INBOUND_COMMANDS) {
      if (command.when.call(this, ctx) && await command.handle.call(this, ctx)) {
        return;
      }
    }
    const passthrough = this.policy().customPassthroughCommands ?? [];
    if (ctx.text.startsWith('/') && passthrough.includes(ctx.slashName)) {
      await passthroughCommand.call(this, ctx);
      return;
    }
    const turn = turnText.call(this, ctx, passthrough);
    // Identity challenges are control-plane material, including platform replays after verification.
    if (/^BOTMUX-ID-[A-Fa-f0-9]{32}$/.test(ctx.text)
      || (ctx.text.startsWith('/') && !turn.commandTrigger && !turn.summary && ctx.text !== '/start')
      || !ctx.text
      || message.attachments.length) {
      await refuseTurn.call(this, ctx, 'unsupported', '目前支持文字对话及 /status、/stop、/restart。图片、文件、话题和飞书工具暂不支持。');
      return;
    }
    if (ctx.active) {
      await refuseTurn.call(this, ctx, 'busy', '当前任务仍在处理，请等待结果，或使用 /stop。');
      return;
    }
    const sessionId = this.state.routes[ctx.route];
    if (sessionId && this.state.sessionLocks?.[sessionId]) {
      await refuseTurn.call(this, ctx, 'busy', '会话已暂停或管理操作尚未确认，请先在Dashboard恢复或检查会话。');
      return;
    }
    await admitTask.call(this, ctx, turn, sessionId);
  });
}

/**
 * The `/stop` fast path, beside the lane. The lane handles the same message
 * later as a `/stop` command.
 */
function stopBesideTheLane(this: WecomBridge, message: WecomInboundMessage): void {
  // Persist cancellation immediately even while the normal queue awaits network I/O.
  // JavaScript state writes are synchronous; no read-modify-write crosses this save.
  const eventKey = messageKey(this, message);
  if (!this.halted
    && !this.poisoned
    && !this.state.seen[eventKey]
    && !this.state.tasks[eventKey]
    && this.allowed(message.userId)
    && message.text.trim().toLowerCase() === '/stop') {
    const route = this.routeForMessage(message);
    const task = Object.values(this.state.tasks).find(item => item.route === route && !item.delivered);
    if (task && task.message.userId === message.userId) {
      task.stopRequested = true;
      if (!task.dispatchAttempted && !task.sessionId) {
        task.result = '任务已停止。';
      }
      this.save();
    }
  }
}

/** A message from someone without access: record a talk-permission request and tell who can approve it, once. */
async function requestTalkGrant(this: WecomBridge, message: WecomInboundMessage): Promise<void> {
  const p = this.policy();
  if (!p.blockedUsers?.includes(message.userId) && p.autoGrantRequestCards) {
    const request = nativeRequestGrant(this.state.native!, p, message, Date.now());
    this.save();
    if (!request.notification) {
      request.notification = 'intent';
      this.save();
      // Allowed users approve; only those who have messaged the bot privately can be reached there.
      const recipients = p.grantRequestToOwnerDm
        ? p.allowedUsers.filter(u => this.state.native!.privateUsers[u] && !p.blockedUsers?.includes(u))
        : [];
      try {
        const card: WecomTemplateCard = {
          card_type: 'button_interaction',
          task_id: `grant-${request.id}`,
          main_title: { title: '申请对话权限' },
          sub_title_text: `用户 ${message.userId} 申请当前会话对话权限；15分钟内有效。`,
          button_list: [{ text: '批准对话', key: `grant:${request.id}` }],
        };
        if (recipients.length) {
          for (const u of recipients) {
            await this.options.transport.sendCard?.(u, card);
          }
        } else {
          await this.options.transport.reply(message, `已登记权限申请 ${request.id}，请管理员使用 /grant-approve ${request.id}。`);
        }
        request.notification = 'sent';
      } catch {
        request.notification = 'uncertain';
      }
      this.save();
    }
  }
}

/**
 * Record the message as seen (in memory: the first save of the step that
 * handles it writes it) and build its context; undefined for a message
 * already seen or admitted.
 */
function markSeen(
  this: WecomBridge,
  message: WecomInboundMessage,
  capability: InboundContext['capability'],
): InboundContext | undefined {
  if (message.chatType === 'single') {
    this.state.native!.privateUsers[message.userId] = true;
  }
  const route = this.routeForMessage(message);
  const key = messageKey(this, message);
  if (this.state.tasks[key] || this.state.seen[key]) {
    this.admission('duplicate', message);
    return undefined;
  }
  this.state.seen[key] = Date.now();
  const active = Object.values(this.state.tasks).find(task => task.route === route && !task.delivered);
  const text = message.text.trim();
  return {
    message,
    capability,
    route,
    key,
    active,
    text,
    // Gateway consumes only this subset of the shared command schema.
    command: text.startsWith('/') && !/\s/.test(text) ? nativeWecomCommand(text)?.name : undefined,
    slashName: text.split(/\s/, 1)[0].toLowerCase(),
  };
}

/** Save (the message is seen), then reply to it. */
function saveThenReply(this: WecomBridge, ctx: InboundContext, text: string): Promise<void> {
  this.save();
  return this.options.transport.reply(ctx.message, text);
}

/** A message that does not become a turn: saved, observed as `outcome`, answered. */
function refuseTurn(this: WecomBridge, ctx: InboundContext, outcome: WecomAdmissionOutcome, text: string): Promise<void> {
  this.save();
  this.admission(outcome, ctx.message);
  return this.options.transport.reply(ctx.message, text);
}

const INBOUND_COMMANDS: readonly InboundCommand[] = [
  // /grant, /revoke, /grant-approve.
  {
    when(ctx) {
      return GRANT_COMMAND.test(ctx.text);
    },
    async handle(ctx) {
      const [, operation, args = ''] = GRANT_COMMAND.exec(ctx.text)!;
      await grantCommand.call(this, ctx, operation, args);
      return true;
    },
  },
  // /repo: list the repositories, or select one for the next new session.
  {
    when(ctx) {
      return ctx.text === '/repo' || ctx.text.startsWith('/repo ');
    },
    async handle(ctx) {
      await repoCommand.call(this, ctx);
      return true;
    },
  },
  // A text answer to a CLI ask (native-ask.ts).
  {
    when() {
      return !!this.options.core.asks && !!this.options.core.answerAsk;
    },
    handle(ctx) {
      return wecomAskText({
        state: this.state,
        core: this.options.core as NativeAskCore,
        message: ctx.message,
        allowed: user => this.capability({ ...ctx.message, userId: user }, false) !== 'denied',
        current: origin => Object.values(this.state.tasks).some(t => t.sessionId === origin.sessionId
          && t.triggerId === origin.turnId
          && !t.revoked
          && !t.stopRequested
          && this.taskAllowed(t)),
        reply: text => this.options.transport.reply(ctx.message, text),
      });
    },
  },
  // /help, /commands (native-platform.ts).
  {
    when() {
      return true;
    },
    handle(ctx) {
      return platformReceive({
        message: ctx.message,
        transport: this.options.transport,
        save: () => this.save(),
      });
    },
  },
  // /feedback <final card task id> <comment>.
  {
    when(ctx) {
      return FEEDBACK_COMMENT.test(ctx.text);
    },
    async handle(ctx) {
      const [, cardTaskId, comment] = FEEDBACK_COMMENT.exec(ctx.text)!;
      await feedbackComment.call(this, ctx, cardTaskId, comment);
      return true;
    },
  },
  // Talk permission covers only the commands configured for it.
  {
    when(ctx) {
      return ctx.capability === 'talk'
        && ctx.text.startsWith('/')
        && !['/feedback'].includes(ctx.text.split(/\s/)[0])
        && !(this.policy().canTalkDaemonCommands ?? WECOM_DEFAULT_TALK_COMMANDS).includes(ctx.command ?? '');
    },
    async handle(ctx) {
      await saveThenReply.call(this, ctx, '此操作需要管理权限。');
      return true;
    },
  },
  {
    when(ctx) {
      return ctx.command === '/status';
    },
    async handle(ctx) {
      this.admission('command', ctx.message);
      await saveThenReply.call(this, ctx, ctx.active ? '任务处理中。' : '当前没有运行中的任务。');
      return true;
    },
  },
  // /stop of a task someone else started.
  {
    when(ctx) {
      return ctx.command === '/stop' && !!ctx.active && ctx.active.message.userId !== ctx.message.userId;
    },
    async handle(ctx) {
      await saveThenReply.call(this, ctx, '当前任务由其他成员发起，请由发起人停止任务。');
      return true;
    },
  },
  {
    when(ctx) {
      return ctx.command === '/stop';
    },
    async handle(ctx) {
      await stopCommand.call(this, ctx);
      return true;
    },
  },
  {
    when(ctx) {
      return ctx.command === '/restart';
    },
    async handle(ctx) {
      this.admission('command', ctx.message);
      if (ctx.active) {
        await saveThenReply.call(this, ctx, '请先停止当前任务，等待结束后再新建会话。');
        return true;
      }
      delete this.state.routes[ctx.route];
      await saveThenReply.call(this, ctx, '已开始新会话。下一条消息会创建新的 CLI 会话。');
      return true;
    },
  },
];

async function grantCommand(this: WecomBridge, ctx: InboundContext, operation: string, args: string): Promise<void> {
  const { message } = ctx;
  try {
    if (operation === 'grant-approve') {
      if (!nativeApproveRequest(this.state.native!, this.policy(), args.trim(), message.userId, Date.now())) {
        throw new Error();
      }
    } else {
      const [userId, rights = 'talk'] = args.trim().split(/\s+/);
      if (!userId
        || !['talk', 'operate'].includes(rights)
        || !nativeCanApprove(this.policy(), message.userId)) {
        throw new Error();
      }
      if (operation === 'grant') {
        nativeGrant(
          this.state.native!,
          this.policy(),
          message.userId,
          userId,
          nativeScope(message),
          rights as 'talk' | 'operate',
          Date.now(),
        );
      } else {
        const g = this.state.native!.grants[nativeGrantKey(userId, nativeScope(message))];
        if (g) {
          g.revoked = true;
          g.revision++;
          this.state.native!.epoch++;
        }
      }
    }
    await saveThenReply.call(this, ctx, '权限变更已保存。');
  } catch {
    await saveThenReply.call(this, ctx, '权限变更被拒绝或申请已过期。');
  }
}

async function repoCommand(this: WecomBridge, ctx: InboundContext): Promise<void> {
  const { route, text } = ctx;
  if (ctx.capability !== 'operate' || ctx.active) {
    await saveThenReply.call(this, ctx, '选仓需要管理权限及空闲会话。');
    return;
  }
  const arg = text.slice(5).trim();
  const p = this.policy();
  if (!arg) {
    const scan = scanWecomRepositories(p.workingDirectory);
    if (scan.ok && scan.repositories.length) {
      this.repoListings.set(route, scan.repositories);
    } else {
      this.repoListings.delete(route);
    }
    await saveThenReply.call(this, ctx, wecomRepositoryListing(scan));
    return;
  }
  let repo: WecomRepository | undefined;
  if (/^\d+$/.test(arg)) {
    // A number picks from this route's latest listing, like the Feishu `/repo <n>`.
    const listing = this.repoListings.get(route);
    if (!listing) {
      await saveThenReply.call(this, ctx, '请先发送 /repo 列出可选仓库，再按序号选择。');
      return;
    }
    repo = listing[Number(arg) - 1];
    if (!repo) {
      await saveThenReply.call(this, ctx, `序号超出范围，请在 1–${listing.length} 中选择。`);
      return;
    }
  } else {
    const matches = wecomRepositoryMatches(scanWecomRepositories(p.workingDirectory), p.workingDirectory, arg);
    if (matches.length > 1) {
      await saveThenReply.call(this, ctx, '有多个仓库与此名称对应，请改用序号，或以 ./ 开头的相对路径选择。');
      return;
    }
    repo = matches[0];
  }
  if (!repo || !wecomRepositoryStillValid(repo, p.workingDirectory)) {
    await saveThenReply.call(this, ctx, '仓库不在当前允许范围或目录不可用。');
    return;
  }
  this.state.native!.selectedRepos[route] = { name: repo.name, directory: repo.directory, revision: nativePolicyRevision(p) };
  delete this.state.routes[route];
  await saveThenReply.call(this, ctx, `已选择仓库 ${repo.name}（${repo.path}）；下一条消息创建新会话。`);
}

/**
 * A comment on one's negative feedback, for the delivered task whose final
 * card is `cardTaskId`, under the rules of that card's buttons
 * (card-events.ts). Anything else is saved as seen and not answered.
 */
async function feedbackComment(this: WecomBridge, ctx: InboundContext, cardTaskId: string, comment: string): Promise<void> {
  const { message } = ctx;
  const task = Object.values(this.state.tasks).find(item => `${item.streamId}-final` === cardTaskId);
  const entry = task?.feedback?.[message.userId];
  const config = task?.feedbackPolicy;
  const current = task ? wecomFeedbackPolicy(this.policy(), task.message.conversationId) : undefined;
  if (task?.delivered
    && !task.revoked
    && this.recipient(task) === message.conversationId
    && task.message.chatType === message.chatType
    && config
    && current?.enabled
    && (current.audience === 'everyone'
      || (current.audience === 'requester'
        ? message.userId === task.message.userId
        : current.reviewers.includes(message.userId)))
    && entry?.semantic === 'negative'
    && config.negativeFollowup.comment.enabled
    && comment.length <= config.negativeFollowup.comment.maxLength
    && !taskCardActionsExpired(task)) {
    entry.comment = comment;
    entry.revision++;
    entry.pending = config.negativeFollowup.reasons.length > 0 && !entry.reason;
    enqueueWecomFeedbackEvent(this.state, this.policy(), {
      type: 'feedback.revised',
      botId: this.options.botId,
      taskId: task.streamId,
      sessionId: task.sessionId!,
      triggerId: task.triggerId!,
      conversationId: message.conversationId,
      actor: message.userId,
      revision: entry.revision,
      feedback: entry,
    });
    await saveThenReply.call(this, ctx, '反馈评论已记录。');
  } else {
    this.save();
  }
}

/** `/stop` from the requester, on the lane: stop the route's task, interrupting its turn when it has one. */
async function stopCommand(this: WecomBridge, ctx: InboundContext): Promise<void> {
  const { active } = ctx;
  this.admission('command', ctx.message);
  this.save();
  if (active) {
    active.stopRequested = true;
    this.save();
    if (!active.sessionId && !active.triggerId && !active.dispatchAttempted) {
      active.result = '任务已停止。';
      this.save();
    } else if (active.sessionId && active.triggerId) {
      try {
        await this.options.core.interrupt(active.sessionId, active.triggerId);
      } catch { /* poll authoritative terminal state */ }
    }
  }
  await this.options.transport.reply(ctx.message, active ? '已请求停止当前任务。' : '当前没有运行中的任务。');
}

/** A configured CLI command, passed to the route's idle session at most once. */
async function passthroughCommand(this: WecomBridge, ctx: InboundContext): Promise<void> {
  const { message, route, text } = ctx;
  this.save();
  this.admission('command', message);
  const sessionId = this.state.routes[route];
  if (ctx.active || !sessionId || this.state.sessionLocks?.[sessionId] || !this.options.core.slash) {
    await this.options.transport.reply(message, '需要已有的空闲 CLI 会话才能执行此命令。');
    return;
  }
  // Durable seen precedes this at-most-once operation. Never replay an
  // uncertain CLI command when its response is lost.
  try {
    await this.options.core.slash(sessionId, text);
    await this.options.transport.reply(message, '已提交 CLI 命令。');
  } catch (error) {
    if (isSlashSessionGone(error)) {
      // The core no longer has this session, so nothing ran: the route is
      // stale, and the conversation has no CLI session to run it in.
      if (this.state.routes[route] === sessionId) {
        delete this.state.routes[route];
      }
      this.save();
      await this.options.transport.reply(message, '需要已有的空闲 CLI 会话才能执行此命令。');
      return;
    }
    await this.options.transport.reply(message, '命令结果未确认，请检查会话；不会自动重试。');
  }
}

/** The text of the turn: a `/summary` prompt, a command trigger's prompt, or the message text itself. */
function turnText(this: WecomBridge, ctx: InboundContext, passthrough: string[]): TurnText {
  const { message, text, slashName, route } = ctx;
  const triggerConfig = this.policy().commandTriggers;
  const commandTrigger = triggerConfig?.enabled
    && isCommandTriggerChat(triggerConfig, message.conversationId)
    && !reservedCommandKind(slashName, new Set(passthrough))
    ? triggerConfig.commands.find(entry => entry.cmd === slashName)
    : undefined;
  const summary = text === '/summary'
    ? wecomObservedSummary(message, this.policy(), this.state, Date.now(), route)
    : undefined;
  const promptText = summary?.prompt
    ?? (commandTrigger
      ? renderCommandTriggerPrompt({ ...commandTrigger, args: commandTriggerArgs(text) }) ?? text
      : text);
  return { commandTrigger, summary, promptText };
}

/**
 * Admit the message as a new task of its route, in `sessionId` or a new
 * session: the task with its frozen request is saved before anything is sent,
 * then the "正在处理…" stream card opens.
 */
async function admitTask(this: WecomBridge, ctx: InboundContext, turn: TurnText, sessionId: string | undefined): Promise<void> {
  const { message, route, key } = ctx;
  const { summary, promptText } = turn;
  const policy = this.policy();
  const userText = policy.senderTag === false ? promptText : `[企业微信用户 ${message.userId}]\n${promptText}`;
  const repository = await turnRepository.call(this, { route, message, key, policy, sessionId });
  if ('refusal' in repository) {
    await saveThenReply.call(this, ctx, repository.refusal);
    return;
  }
  if (!nativeReserve(this.state.native!, policy, message, key, Date.now())) {
    await saveThenReply.call(this, ctx, '当前对话额度已用完。');
    return;
  }
  const frozen = wecomTurnRequest.call(this, {
    message,
    key,
    envelope: wecomTurnEnvelope(userText),
    policy,
    sessionId,
    selected: repository.selected,
  });
  // The admission notice is recorded with the task, so the end of the turn
  // closes what was actually opened, whatever the policy is by then.
  const admissionNotice: Task['admissionNotice'] = !policy.disableStreamingCard && policy.replyCardMode !== 'final-only'
    ? 'stream'
    : 'none';
  this.state.tasks[key] = {
    message,
    route,
    request: frozen.request,
    streamId: key,
    createdAt: Date.now(),
    model: frozen.model,
    admissionNotice,
    workingDirectory: frozen.workingDirectory,
  };
  if (summary?.cursor) {
    (this.state.summaryCursors ??= {})[route] = summary.cursor;
  }
  this.save();
  this.admission('accepted', message);
  // A failed acknowledgement must never remove durable admission.
  try {
    if (admissionNotice === 'stream') {
      await this.options.transport.reply(message, '正在处理…', { streamId: key, finish: false });
    }
    if (admissionNotice !== 'none') {
      this.state.tasks[key].admissionNoticeSent = true;
      this.save();
    }
  } catch { /* final uses proactive delivery */ }
}
