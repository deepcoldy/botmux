/**
 * 免@ 斜杠命令（commandTriggers）的运行期判定。
 *
 * 目标场景：普通群里旁人直接发一条 `/solve`（没 @ 任何 bot），把它当作对本 bot
 * 的寻址，喂进该群已有的 chat-scope 会话续聊。
 *
 * 三道闸，顺序即优先级，任何一道不过都当没读到这条消息：
 *   1. 群维度 —— excludedChats 黑名单 deny-wins；chats 白名单为空表示「所有群」。
 *      这是多 bot 群里的**唯一**消歧手段：一 bot 一 daemon 进程，各自只读自己
 *      的 bots.json entry，daemon 之间没有裸命令归属的仲裁协议。把 chats 留空
 *      （所有群）时，群里每个同样开了该命令的 bot 都会应答 —— 这是配置者的选择，
 *      dashboard 侧会显式警告。
 *   2. 命令白名单 —— 只有配置里列出的命令才免@，不是「所有 / 开头的消息」。
 *   3. 保留命令 fail-closed —— botmux 自己的命令（/close /cd …）与透传给 CLI 的
 *      破坏性命令（/clear /new …）**必须 @ 才能触发**，即使有人手改 bots.json 把
 *      它们塞进白名单也不生效。dashboard 在保存时就会拒绝，这里是兜底。
 *
 * 调用方把已解析好的首 token 传进来（parseSlashCommandInvocation 的 `cmd`），
 * 本模块因此不必 import command-handler —— 避免给既有的
 * event-dispatcher ↔ command-handler 环再加一条边。
 */
import { getBot, type CommandTriggerCommand, type CommandTriggerConfig } from '../bot-registry.js';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS } from '../core/passthrough-commands.js';

export type ReservedCommandKind = 'daemon' | 'passthrough' | 'force-topic';

/**
 * 路由元命令：`parseForceTopicInvocation` 在命令表之前拦截，不在 DAEMON_COMMANDS
 * 里，所以必须单列，否则 `/t` 会成为一个可配置的免@ 命令并强制开新话题。
 */
const FORCE_TOPIC_COMMANDS = new Set(['/t', '/topic']);

/**
 * 该命令是否属于 botmux 保留命令（→ 必须 @ 才能触发）。
 *
 * `SESSIONLESS_DAEMON_COMMANDS` 与 `EXISTING_SESSION_ONLY_DAEMON_COMMANDS` 都是
 * `DAEMON_COMMANDS` 的子集（有单测钉住），所以这里只查 DAEMON_COMMANDS 即可覆盖
 * 三张表，不必 import command-handler。
 *
 * @param extraPassthrough  按 bot 的**实际 CLI** 解析出的透传命令集
 *   （`resolvePassthroughCommands(larkAppId)`）。adapter 会往里追加自己的命令，
 *   且 codex-app/mira/dsh 这类无裸输入面的 CLI 会返回空集 —— 所以判定必须按 bot
 *   求值，不能只用静态常量。省略时退回静态集（仍是 fail-closed 的下界）。
 */
export function reservedCommandKind(
  cmd: string,
  extraPassthrough?: ReadonlySet<string>,
): ReservedCommandKind | null {
  const c = cmd.trim().toLowerCase();
  if (DAEMON_COMMANDS.has(c)) return 'daemon';
  if (FORCE_TOPIC_COMMANDS.has(c)) return 'force-topic';
  if (PASSTHROUGH_COMMANDS.has(c) || extraPassthrough?.has(c)) return 'passthrough';
  return null;
}

/** 群维度：黑名单 deny-wins，白名单为空 = 所有群（与 isSubstituteAllowedChat 同构）。 */
export function isCommandTriggerChat(
  cfg: Pick<CommandTriggerConfig, 'chats' | 'excludedChats'> | undefined,
  chatId: string | undefined,
): boolean {
  if (!chatId) return false;
  if (cfg?.excludedChats?.includes(chatId)) return false;
  if (!cfg?.chats?.length) return true;
  return cfg.chats.includes(chatId);
}

export function getCommandTriggers(larkAppId: string): CommandTriggerConfig | undefined {
  try {
    return getBot(larkAppId).config.commandTriggers;
  } catch {
    return undefined;
  }
}

/** 一次命中：配置里的条目 + 本条消息带的参数。 */
export interface CommandTriggerMatch {
  cmd: string;
  /** 配置的 prompt 模板；缺省表示「原文投给会话」。 */
  prompt?: string;
  /** 命令后面那段文本（原样保留大小写与换行）。 */
  args: string;
}

/**
 * 这条已解析出的斜杠命令能否在该群免@ 触发本 bot；命中则返回配置条目。
 *
 * 调用方仍需自行结算发送者权限（canTalk）—— 本函数只回答「寻址」问题，不回答
 * 「谁有资格」。
 */
export function matchCommandTrigger(
  larkAppId: string,
  chatId: string | undefined,
  cmd: string | undefined,
  extraPassthrough?: ReadonlySet<string>,
): CommandTriggerCommand | undefined {
  if (!cmd) return undefined;
  const cfg = getCommandTriggers(larkAppId);
  if (!cfg?.enabled) return undefined;
  if (!isCommandTriggerChat(cfg, chatId)) return undefined;
  const c = cmd.trim().toLowerCase();
  const entry = cfg.commands.find(e => e.cmd === c);
  if (!entry) return undefined;
  return reservedCommandKind(c, extraPassthrough) === null ? entry : undefined;
}

/**
 * 剥掉首个命令词，剩下的就是参数。用原始文本（而非小写化的 cmd）切，避免把
 * `/Solve` 这类大小写差异算错长度。
 */
export function commandTriggerArgs(text: string): string {
  return text.replace(/^\s*\/\S+\s*/, '');
}

/**
 * 渲染命中后真正交给 Agent 的正文。
 *
 * 没配模板 → undefined（调用方保留用户原文）。配了模板：`{args}` 处替换成参数；
 * 模板里没有 `{args}` 而用户又带了参数时，把参数追加在末尾 —— 宁可多一段，也不
 * 让用户敲进去的东西静默消失。
 */
export function renderCommandTriggerPrompt(match: CommandTriggerMatch): string | undefined {
  const prompt = match.prompt?.trim();
  if (!prompt) return undefined;
  const args = match.args.trim();
  if (prompt.includes('{args}')) return prompt.split('{args}').join(args);
  return args ? `${prompt}\n\n${args}` : prompt;
}
