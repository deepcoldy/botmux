/**
 * 个人助理模式（`assistantMode: true`）的纯函数集合。
 *
 * 一个 bot 开了助理模式后，每个会话有且只有一个 owner（私聊 = 发消息的人，
 * 群 = 把 bot 拉进群的人），目录、CLI 数据目录、沙盒授权、宿主侧读接口全部
 * 按 owner 收窄。这里只放路径推导、open_id 形状校验、模板同步、凭证副本
 * 改写这几件不依赖 daemon/worker 状态的事，方便单测；接线在 daemon.ts /
 * worker.ts。设计见 docs/design/2026-11-20-assistant-mode.md。
 */
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** open_id 要被拼进沙盒白名单路径，所以形状必须收紧到飞书实际发的样子：
 *  `ou_` + 32 位十六进制。不合形状 fail-closed（拒绝 spawn），绝不拼路径。 */
export const ASSISTANT_OPEN_ID_RE = /^ou_[a-f0-9]{32}$/;

export function isValidAssistantOpenId(openId: unknown): openId is string {
  return typeof openId === 'string' && ASSISTANT_OPEN_ID_RE.test(openId);
}

/** `<BOT_HOME>/users/<open_id>`：owner 的全部可写面（work/ + claude/）。 */
export function assistantUserHome(botHome: string, openId: string): string {
  if (!isValidAssistantOpenId(openId)) throw new Error(`assistant mode: invalid owner open_id ${String(openId).slice(0, 16)}`);
  return join(botHome, 'users', openId);
}

/** owner 名下所有会话的 cwd。 */
export function assistantWorkDir(userHome: string): string {
  return join(userHome, 'work');
}

/** owner 的附件桶（相对 attachments/<appId>/）。 */
export function assistantAttachmentsBucket(sessionDataDir: string, appId: string, openId: string): string {
  if (!isValidAssistantOpenId(openId)) throw new Error('assistant mode: invalid owner open_id');
  return join(sessionDataDir, 'attachments', appId, 'u', openId);
}

/** 副本里的 refreshToken 换成垃圾串：用户副本只拿 AT 干活，永远不能轮换账号的
 *  RT。某个忙会话跑过 AT 过期点时只会死它自己（Claude 刷新失败清空自己那份），
 *  伤不到共享账号。非 claudeAiOauth 形状的内容原样返回。 */
export const ASSISTANT_NO_REFRESH_TOKEN = 'botmux-assistant-mode-no-refresh';

export function stripRefreshToken(raw: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return raw; }
  if (!parsed || typeof parsed !== 'object') return raw;
  const o = parsed as Record<string, unknown>;
  const oauth = o.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return raw;
  return JSON.stringify({ ...o, claudeAiOauth: { ...(oauth as Record<string, unknown>), refreshToken: ASSISTANT_NO_REFRESH_TOKEN } });
}

export interface TemplateSyncResult { copied: number; skippedSymlinks: number }

/**
 * 把模板目录覆盖同步进 work/：模板有的文件覆盖写入，模板没的不删（用户自己的产物
 * 保留）。两端都不跟符号链接：源端链接跳过（模板里的链接可能指向库外）；**目标端**
 * 任何一层是链接就先删掉再写——work/ 对 owner 可写，他能把 `work/CLAUDE.md` 或
 * `work/knowledge` 链到别人的目录，worker 在宿主上跑、不受沙盒约束，跟过去就是替他
 * 越权写。文件先写进同目录的随机临时名（O_EXCL，不会被预埋的链接劫持）再 rename。
 * 模板目录不存在 → 抛错，由调用方决定是否拒绝 spawn。
 */
export function syncAssistantTemplate(templateDir: string, workDir: string): TemplateSyncResult {
  const st = lstatSync(templateDir);
  if (!st.isDirectory()) throw new Error(`assistant template is not a directory: ${templateDir}`);
  const result: TemplateSyncResult = { copied: 0, skippedSymlinks: 0 };
  const ensureRealDir = (dst: string): void => {
    let e;
    try { e = lstatSync(dst); } catch { e = undefined; }
    if (e && e.isSymbolicLink()) { unlinkSync(dst); e = undefined; }
    if (e && !e.isDirectory()) { rmSync(dst, { force: true }); e = undefined; }
    if (!e) mkdirSync(dst, { recursive: true });
  };
  const walk = (src: string, dst: string): void => {
    ensureRealDir(dst);
    for (const name of readdirSync(src)) {
      const s = join(src, name), d = join(dst, name);
      const e = lstatSync(s);
      if (e.isSymbolicLink()) { result.skippedSymlinks++; continue; }
      if (e.isDirectory()) { walk(s, d); continue; }
      if (!e.isFile()) continue;
      let cur;
      try { cur = lstatSync(d); } catch { cur = undefined; }
      if (cur && (cur.isSymbolicLink() || cur.isDirectory())) rmSync(d, { recursive: true, force: true });
      const tmp = join(dst, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
      copyFileSync(s, tmp, fsConstants.COPYFILE_EXCL);
      renameSync(tmp, d);
      result.copied++;
    }
  };
  walk(templateDir, workDir);
  return result;
}

export type AssistantOwnerHow = 'p2p' | 'session-group' | 'bot-added' | 'claimed' | 'admin';

export interface AssistantOwnerRecord {
  openId: string;
  since: string;
  how: AssistantOwnerHow;
  /** owner 已退群：群进入「待认领」，不再服务，直到有人 /assistant claim。 */
  left?: string;
}

/**
 * 冷启动前清掉 owner 可写目录（USER_HOME/claude、USER_HOME/codex）顶层的符号链接。
 * worker 在宿主上跑、不受沙盒约束：provisioning 要往这些目录写 `.credentials.json` /
 * `settings.json` / `.claude.json` / `config.toml`，owner 要是把同名文件链到共享的
 * `~/.claude/...`，宿主就替他把（去 RT 的）凭证或 hooks 写进全机共享文件。目录本身是
 * 链接 → 抛错（调用方拒绝 spawn）。返回被删掉的条目名。
 */
export function removeTopLevelSymlinks(dir: string): string[] {
  let st;
  try { st = lstatSync(dir); } catch { return []; }
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink`);
  if (!st.isDirectory()) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (lstatSync(p).isSymbolicLink()) { unlinkSync(p); removed.push(name); }
    } catch { /* 并发消失 → 忽略 */ }
  }
  return removed;
}

/**
 * 会话归属判定（纯函数）。返回 owner open_id；`null` = 群未认领 / owner 已退，
 * 调用方不得 spawn。私聊永远归发消息的人。群：**归属表优先**——表里有记录就以表为准
 * （`left` 记录 = 待认领，哪怕是 /group 会话群的建群人退了群也停服）；没记录时会话群
 * 归 session-group 的 ownerOpenId，普通群 null。任何来源的 id 都要过形状校验。
 */
export function resolveAssistantOwnerOpenId(input: {
  chatType: 'group' | 'p2p';
  senderOpenId?: string;
  sessionGroupOwnerOpenId?: string;
  stored?: AssistantOwnerRecord;
}): string | null {
  if (input.chatType === 'p2p') return isValidAssistantOpenId(input.senderOpenId) ? input.senderOpenId : null;
  const rec = input.stored;
  if (rec) {
    if (rec.left || !isValidAssistantOpenId(rec.openId)) return null;
    return rec.openId;
  }
  if (isValidAssistantOpenId(input.sessionGroupOwnerOpenId)) return input.sessionGroupOwnerOpenId;
  return null;
}

/**
 * 归属变更通知（claim / admin 改绑 / owner 退群）。im 层的 /assistant 命令改了归属表之后
 * 调它，daemon 注册的监听者去退役该群里 owner 不匹配的旧会话——否则 chat-scope 旧会话
 * 一直 active、还挂着旧 owner，新 owner 的消息复用它、fork 永远被归属闸拒绝。
 */
export type AssistantOwnerChangedListener = (larkAppId: string, chatId: string, newOwnerOpenId: string | null) => void;
let ownerChangedListener: AssistantOwnerChangedListener | null = null;
export function setAssistantOwnerChangedListener(fn: AssistantOwnerChangedListener | null): void { ownerChangedListener = fn; }
export function notifyAssistantOwnerChanged(larkAppId: string, chatId: string, newOwnerOpenId: string | null): void {
  try { ownerChangedListener?.(larkAppId, chatId, newOwnerOpenId); } catch { /* listener 自己兜 */ }
}

/**
 * worker init 里助理模式相关的字段（worker-pool 两处 init 组装共用）。owner 为空
 * （非助理模式会话，或助理模式下 daemon 没定出 owner——后者 daemon 侧已拒绝 spawn）
 * 时不带任何字段，worker 走原路径。模板目录缺省 = 调用方给的 fallback
 * （effectiveDefaultWorkingDir）。
 */
export function assistantInitFields(
  cfg: { assistantMode?: boolean; assistantTemplateDir?: string },
  ownerOpenId: string | undefined,
  fallbackTemplateDir: string | undefined,
): { assistantOwnerOpenId?: string; assistantTemplateDir?: string } {
  if (cfg.assistantMode !== true || !isValidAssistantOpenId(ownerOpenId)) return {};
  const tpl = cfg.assistantTemplateDir ?? fallbackTemplateDir;
  return {
    assistantOwnerOpenId: ownerOpenId,
    ...(tpl ? { assistantTemplateDir: tpl } : {}),
  };
}
