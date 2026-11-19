/**
 * 个人助理模式（`assistantMode: true`）的纯函数集合。
 *
 * 一个 bot 开了助理模式后，每个会话有且只有一个 owner（私聊 = 发消息的人，
 * 群 = 把 bot 拉进群的人），目录、CLI 数据目录、沙盒授权、宿主侧读接口全部
 * 按 owner 收窄。这里只放路径推导、open_id 形状校验、模板同步、凭证副本
 * 改写这几件不依赖 daemon/worker 状态的事，方便单测；接线在 daemon.ts /
 * worker.ts。设计见 docs/design/2026-11-20-assistant-mode.md。
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
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
 * 把模板目录覆盖同步进 work/：模板有的文件覆盖写入，模板没有的不删（用户自己的
 * 产物保留）。不跟符号链接（模板里的链接可能指向库外；fail-closed 直接跳过）。
 * 模板目录不存在 → 抛错，由调用方决定是否拒绝 spawn。
 */
export function syncAssistantTemplate(templateDir: string, workDir: string): TemplateSyncResult {
  const st = lstatSync(templateDir);
  if (!st.isDirectory()) throw new Error(`assistant template is not a directory: ${templateDir}`);
  const result: TemplateSyncResult = { copied: 0, skippedSymlinks: 0 };
  const walk = (src: string, dst: string): void => {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      const s = join(src, name), d = join(dst, name);
      const e = lstatSync(s);
      if (e.isSymbolicLink()) { result.skippedSymlinks++; continue; }
      if (e.isDirectory()) { walk(s, d); continue; }
      if (!e.isFile()) continue;
      copyFileSync(s, d);
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
 * 会话归属判定（纯函数）。返回 owner open_id；`null` = 群未认领 / owner 已退，
 * 调用方不得 spawn。私聊永远归发消息的人；会话群归 session-group 的 ownerOpenId；
 * 普通群查表。任何来源的 id 都要过形状校验——拿不到合法 id 一律 null。
 */
export function resolveAssistantOwnerOpenId(input: {
  chatType: 'group' | 'p2p';
  senderOpenId?: string;
  sessionGroupOwnerOpenId?: string;
  stored?: AssistantOwnerRecord;
}): string | null {
  if (input.chatType === 'p2p') return isValidAssistantOpenId(input.senderOpenId) ? input.senderOpenId : null;
  if (isValidAssistantOpenId(input.sessionGroupOwnerOpenId)) return input.sessionGroupOwnerOpenId;
  const rec = input.stored;
  if (!rec || rec.left || !isValidAssistantOpenId(rec.openId)) return null;
  return rec.openId;
}

/**
 * worker init 里助理模式相关的字段（worker-pool 两处 init 组装共用）。owner 为空
 * （非助理模式会话，或助理模式下 daemon 没定出 owner——后者 daemon 侧已拒绝 spawn）
 * 时不带任何字段，worker 走原路径。模板目录缺省 = 调用方给的 fallback
 * （effectiveDefaultWorkingDir）。
 */
export function assistantInitFields(
  cfg: { assistantMode?: boolean; assistantTemplateDir?: string; assistantLarkBotIdentity?: boolean },
  ownerOpenId: string | undefined,
  fallbackTemplateDir: string | undefined,
): { assistantOwnerOpenId?: string; assistantTemplateDir?: string; assistantLarkBotIdentity?: boolean } {
  if (cfg.assistantMode !== true || !isValidAssistantOpenId(ownerOpenId)) return {};
  const tpl = cfg.assistantTemplateDir ?? fallbackTemplateDir;
  return {
    assistantOwnerOpenId: ownerOpenId,
    ...(tpl ? { assistantTemplateDir: tpl } : {}),
    ...(cfg.assistantLarkBotIdentity === true ? { assistantLarkBotIdentity: true } : {}),
  };
}
