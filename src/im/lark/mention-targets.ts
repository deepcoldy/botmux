/**
 * 「@执行bot /<cmd> @目标…」形态元命令的共享 mention 解析。
 *
 * `/grant`、`/invite` 这类命令的同一种 mention 语义：
 *  - 命令词**之前**的 @ 是「点名让哪个 bot 执行」——不是目标（多 bot 群里
 *    owner 常同时 @ 多个操作 bot，位置过滤走错会把操作 bot 当目标，实测踩过：
 *    两 bot 互相 grant）；
 *  - 命令词**之后**的 @ 才是目标；排除执行 bot 自身；
 *  - text 形态（content.text 里是 key 占位符）与 post 富文本形态（inline at
 *    节点、message.mentions 常为空）都要支持；位置信息缺失的合成消息退回
 *    「全部非本 bot mention」的历史宽松行为。
 *
 * 从 grant-command.ts 提炼泛化（2026-07 /invite 落地时）；grant 的对外导出
 * （parseGrantTargets / isGrantTargetOnly / stripAllMentions）保持原样委托到这里。
 */
import { mentionIdentity } from './message-parser.js';

/** 命令正则必须带 `\b` 边界、不带 g 标志（exec/index 语义依赖）。 */
export type CommandPattern = RegExp;

/**
 * `openId`：mention 的 open_id（可能为空——飞书用 `{id_type:'app_id', id:'cli_xxx'}`
 * 形态标识**群外 bot**，此时无 open_id，见 message-parser 的 mentionOpenId 注释）。
 * `appId`：mention 的 app_id（仅 app_id 形态 mention 才有）。
 * 二者至少有一个非空该 target 才被收录（/invite 拉群外 bot 主场景恰恰只有 appId）。
 * /grant 只消费 openId（授权对象必须是 open_id 主体），app_id-only 目标由
 * parseGrantTargets 过滤掉——grant 行为与历史 byte-parity（app_id 形态过去被
 * mentionOpenId 直接 drop，本就不在 grant 目标里）。
 */
export interface MentionTarget { openId: string; name: string; appId?: string }

/**
 * 从 mention 列表取「cmdPattern 匹配的命令词之后」出现的所有非本 bot @，按
 * open_id 去重、保持 @ 顺序（支持一次命令带多目标）。
 */
export function parseTargetsAfterCommand(
  message: any, botOpenId: string | undefined, cmdPattern: CommandPattern,
): MentionTarget[] {
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { content = undefined; }

  // text 形态：@ 落在 content.text 里，每个 mention 带 key 占位符可定位其位置 → 按命令词位置过滤。
  if (content && typeof content.text === 'string') {
    return parseTextTargetsAfterCommand(content.text, message?.mentions ?? [], botOpenId, cmdPattern);
  }
  // post（富文本）形态：@ 落在 inline `at` 节点（message.mentions 常为空、偶有填充，统一走节点序）→
  // 按命令词节点位置过滤，不被「message.mentions 是否填充」左右。
  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (Array.isArray(inner?.content)) {
    return parsePostAtMentions(message, botOpenId, cmdPattern);
  }

  // 合成消息（仅 mentions、无 content 结构，多见于单测/旧调用）：无位置信息，退回全部非本 bot。
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const x of (message?.mentions ?? [])) {
    const { openId: oid, appId } = mentionIdentity(x);
    const dedup = oid || appId;                 // app_id 形态无 open_id，用 appId 去重
    if (!dedup || oid === botOpenId || appId === botOpenId || seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ openId: oid ?? '', name: x.name ?? oid ?? appId ?? '', appId });
  }
  return out;
}

/** text 形态：只取「命令词之后」的非本 bot mention。用 mention 的 key 占位符定位其在 text 里的
 *  位置；`key(?!\d)` 边界规避 @_user_1 / @_user_10 前缀歧义（与 isCommandTargetOnly 同款）。
 *  定位不到 key（异常形态）时保守退回「视为目标」，与历史行为一致，不漏真实 target。 */
function parseTextTargetsAfterCommand(
  text: string, mentions: any[], botOpenId: string | undefined, cmdPattern: CommandPattern,
): MentionTarget[] {
  const cmdIdx = text.search(cmdPattern);
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const m of mentions) {
    const { openId: oid, appId } = mentionIdentity(m);
    const dedup = oid || appId;                 // app_id 形态（群外 bot）无 open_id，用 appId 去重
    if (!dedup || oid === botOpenId || appId === botOpenId || seen.has(dedup)) continue;
    const key = m?.key;
    if (cmdIdx >= 0 && typeof key === 'string' && key.length > 0) {
      const km = new RegExp(`${escapeRe(key)}(?!\\d)`).exec(text);
      if (km && km.index <= cmdIdx) continue;   // 命令词之前 = 操作 bot 点名，剔除
    }
    seen.add(dedup);
    out.push({ openId: oid ?? '', name: m.name ?? oid ?? appId ?? '', appId });
  }
  return out;
}

/** 从 post inline `at` 节点取非本 bot 的目标（user_name 兜 name），按 user_id 去重、保持顺序。
 *  同 text 形态：只收「命令词文本节点之后」的 `at` 节点（前导 @ 是操作 bot 点名，剔除）。 */
function parsePostAtMentions(message: any, botOpenId: string | undefined, cmdPattern: CommandPattern): MentionTarget[] {
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { return out; }
  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (!Array.isArray(inner?.content)) return out;
  // 先定位命令词文本节点的序号，再只收其后的 at 节点。
  let seq = 0, cmdSeq = -1;
  const ats: Array<{ id: string; name: string; seq: number }> = [];
  for (const para of inner.content) {
    if (!Array.isArray(para)) continue;
    for (const node of para) {
      if (cmdSeq < 0 && node?.tag === 'text' && cmdPattern.test(node.text ?? '')) cmdSeq = seq;
      if (node?.tag === 'at' && node.user_id) ats.push({ id: node.user_id, name: node.user_name ?? node.user_id, seq });
      seq++;
    }
  }
  for (const a of ats) {
    if (a.id === botOpenId || seen.has(a.id)) continue;
    if (cmdSeq >= 0 && a.seq <= cmdSeq) continue;   // 命令词之前 = 操作 bot 点名，剔除
    seen.add(a.id);
    // 群外 bot 的 at 节点 user_id 是 `cli_` 前缀 app_id（open_id 恒为 `ou_`，不冲突）→
    // 归到 appId 让 /invite 直接拿去拉人；否则按 open_id（/grant、群内 bot）。
    const isAppId = /^cli_/.test(a.id);
    out.push(isAppId ? { openId: '', name: a.name, appId: a.id } : { openId: a.id, name: a.name });
  }
  return out;
}

/**
 * 本 bot 是否「只是作为命令的目标」被 @（@ 出现在命令词之后），而不是被前导 @
 * 点名执行命令的操作 bot。命中（仅目标）返回 true，调用方应静默放手——否则
 * 目标 bot 会误回 owner_only / 把自己剔空后误执行。
 *
 * 本 bot 的身份判据要**同时**认 open_id 与 app_id：飞书对「群外 / 协作 bot」的 @
 * 常以 `{id_type:'app_id', id:'cli_xxx'}` 形态下发（无 open_id），只认 open_id 会
 * 漏判 `@OperatorBot /cmd @ThisBot(app_id 形态)` → guard 不命中 → 目标 bot 误回
 * owner_only / 已在群（实测 blocker，2026-07 /invite app_id 支持）。botAppId 即本
 * bot 的 larkAppId（app_id 形态自我识别用）。
 *
 * text 与 post（富文本）两种消息形态都覆盖（同 parseTargetsAfterCommand）：
 *  - text：{"text":"@_user_1 /cmd @_user_2"}，@ 是占位符 key；用「key 后不接数字」
 *    的边界锁定整 token，规避 @_user_1 / @_user_10 这类 key 前缀歧义。
 *  - post：@ 是独立的 `at` 节点（不在 text 里、mentions 可能为空），按文档节点
 *    顺序比较本 bot 的 `at` 节点与含命令词的 text 节点的先后。
 */
export function isCommandTargetOnly(
  message: any, botOpenId: string | undefined, cmdPattern: CommandPattern, botAppId?: string,
): boolean {
  if (!botOpenId && !botAppId) return false;
  /** 该 mention 是否指向本 bot（open_id 或 app_id 任一命中）。 */
  const isMe = (m: any): boolean => {
    const { openId, appId } = mentionIdentity(m);
    return (!!botOpenId && openId === botOpenId) || (!!botAppId && appId === botAppId);
  };
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { return false; }

  if (typeof content?.text === 'string') {
    const key = (message?.mentions ?? []).find(isMe)?.key;
    if (!key) return false;
    const cmdIdx = content.text.search(cmdPattern);
    const keyMatch = new RegExp(`${escapeRe(key)}(?!\\d)`).exec(content.text);
    const myIdx = keyMatch ? keyMatch.index : -1;
    return cmdIdx >= 0 && myIdx > cmdIdx;
  }

  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (Array.isArray(inner?.content)) {
    let seq = 0, cmdSeq = -1, mySeq = -1;
    for (const para of inner.content) {
      if (!Array.isArray(para)) continue;
      for (const node of para) {
        if (cmdSeq < 0 && node?.tag === 'text' && cmdPattern.test(node.text ?? '')) cmdSeq = seq;
        // post at 节点：user_id 可能是本 bot 的 open_id（群内）或 app_id（cli_ 前缀，群外形态）。
        if (mySeq < 0 && node?.tag === 'at' && node.user_id && (node.user_id === botOpenId || node.user_id === botAppId)) mySeq = seq;
        seq++;
      }
    }
    return cmdSeq >= 0 && mySeq > cmdSeq;
  }
  return false;
}

/** 把文本里所有 `@<name>` mention token 去掉（split/join，防正则注入），归一空白后 trim。 */
export function stripAllMentions(text: string, mentions: any[]): string {
  let s = text;
  for (const m of mentions ?? []) {
    const name = m?.name;
    if (typeof name === 'string' && name.length) s = s.split(`@${name}`).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
