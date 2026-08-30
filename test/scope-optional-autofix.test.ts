/**
 * Source-level guard for the opt-in optional-scope auto-top-up in
 * checkRequiredScopes (src/im/lark/event-dispatcher.ts).
 *
 * checkRequiredScopes is a large network-driven function (real Lark app-info
 * fetch + Open Platform automation), so — mirroring listener-foreign-bot-owner
 * and initial-passthrough-ownership — we pin the behavior we care about on the
 * source region rather than standing up the whole HTTP/browser stack.
 *
 * What must hold (PR #715 — make `botmux restart` pick up a newly-declared
 * NON-critical scope without a trip to the Open Platform, without nagging bots
 * that don't need it):
 *  - When all critical scopes are granted but an optional one is missing, we try
 *    a top-up (missingOptional.length > 0 gate) BEFORE the "all critical granted"
 *    early return.
 *  - That top-up is SILENT (silent:true → no admin DM) and QR-safe
 *    (disableQrLogin:true → a missing/expired web session fails cleanly, no
 *    second QR, no prompt) so a bot with no cached session is unaffected.
 *  - A successful top-up returns; otherwise it falls through to the normal
 *    "all critical granted" return (no behavior change for the no-session case).
 *  - tryAutoFixScopes only pops a QR when NOT disableQrLogin, and skips the
 *    success DM when silent.
 *
 * Run: pnpm vitest run test/scope-optional-autofix.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf-8');

/**
 * 从 `signature` 截到 `endMarker` 为止（含）。
 *
 * ⭐ **本文件不再提供「固定字符宽度」的截法**（原 `fnRegion(sig, span)` 已删）：那种写法
 * 把「代码语义」和「代码在文件里的字节位置」绑在一起，于是**任何无害的说明性改动都能
 * 让断言变红**，而红的信息完全指向错误的方向（看起来像功能没了）。本轮它咬了四次：
 * 目标文本偏移到过 1463 / 5243 / 7933，窗口卡在 1400 / 5200 / 7600；第四处
 * (`ensureVcMeetingEventsSubscribed`) 是被复审者发现的——我一度以为「三个 region 全转
 * 完了」，而恰好同一轮改动给那个函数加了 ~10 行，最紧的断言距窗口尾只剩 633 字符。
 * 故意不留下 `fnRegion`：留着它下一个人还会用，陷阱就会回来。
 */
function fnRegionUntil(signature: string, endMarker: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in event-dispatcher.ts`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start);
  expect(end, `${endMarker} not found after ${signature}`).toBeGreaterThan(start);
  return src.slice(start, end + endMarker.length);
}

describe('checkRequiredScopes — opt-in optional-scope auto-top-up', () => {
  // The all-critical-granted branch, up to (and including) its early return.
  // ⚠️ 窗口宽度要够：这个分支里加过注释/新分支（如「应用审核中就静默跳过」），
  // 卡太紧会让断言因为**文本被推出窗口**而红，看起来像行为回归，实际什么都没改。
  // 截到该分支真正的结尾（终局那句 all-critical-granted 日志之后的 return），不用会随
  // 注释漂移的固定字符宽度 —— 同款窗口在本次改动里已假红三次，见 fnRegionUntil。
  const region = fnRegionUntil('if (missingCritical.length === 0) {', 'all critical scopes granted');

  it('gates the top-up on a missing optional scope', () => {
    expect(region).toContain('if (missingOptional.length > 0 && brand === \'feishu\') {');
  });

  it('runs the top-up SILENTLY and WITHOUT a second QR (session-only)', () => {
    expect(region).toContain('disableQrLogin: true, silent: true');
    // passes no critical scopes (optional-only top-up)
    expect(region).toMatch(/tryAutoFixScopes\(larkAppId, bot, brand, \[\], missingOptional,/);
  });

  it('threads the already-granted scope names into the top-up (no-op-publish diff)', () => {
    // The auto-top-up must forward the scopes it already read back — bucketed by
    // token type — so automation can diff per bucket and skip publishing when
    // nothing is actually new (PR #1044). Bucketing avoids a tenant grant masking
    // a genuinely-missing user-side scope of the same name (PR #1044 R2).
    expect(region).toContain('grantedScopeNames: grantedScopeBuckets');
  });

  it('returns on a successful top-up (before the all-critical-granted log)', () => {
    const topUpIdx = region.indexOf('const toppedUp = await tryAutoFixScopes');
    // 成功判据必须是**真的补上了**（'fixed'），不能是「调用没抛」：应用审核中时
    // 开放平台连 scope/update 都拒（code=10046），一项都没写进去，报 topped-up 是谎报。
    const returnIdx = region.indexOf("if (toppedUp.kind === 'fixed') {", topUpIdx);
    const allGrantedLogIdx = region.indexOf('all critical scopes granted');
    expect(topUpIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(topUpIdx);
    // the success return sits before the terminal all-critical-granted log line
    expect(returnIdx).toBeLessThan(allGrantedLogIdx);
  });

  it('falls through to the normal early return when no session (no behavior change)', () => {
    // the terminal log + return are still present after the optional block
    expect(region).toContain('all critical scopes granted');
  });
});

describe('tryAutoFixScopes — silent / disableQrLogin plumbing', () => {
  // 截到函数体真正的结尾（catch 里那句 auto-fix error 日志），不用会随注释漂移的固定
  // 字符宽度 —— 这段历史上因窗口太窄假红过三次（详见 fnRegionUntil 的注释）。
  const region = fnRegionUntil('async function tryAutoFixScopes(', "logger.warn(`[${larkAppId}] auto-fix error:");

  it('accepts the disableQrLogin + silent opts', () => {
    expect(region).toContain('opts?: { disableQrLogin?: boolean; silent?: boolean; grantedScopeNames?: { tenant: string[]; user: string[] } }');
  });

  it('threads grantedScopeNames into the Open Platform automation', () => {
    expect(region).toContain('grantedScopeNames: opts?.grantedScopeNames,');
  });

  it('only requests the actually-missing scopes (filtered manifest, not the full 300+)', () => {
    // Regression: the automation was called with no scopeManifest, so it applied
    // the entire default manifest. It must now derive the manifest from the
    // missing critical+optional names and pass it through.
    expect(region).toContain('filterScopeManifest(readDefaultScopeManifest(), wantedScopeNames)');
    expect(region).toMatch(/const wantedScopeNames = \[\.\.\.missingCritical, \.\.\.missingOptional\]\.map\(s => s\.name\)/);
    expect(region).toContain('scopeManifest,');
  });

  it('threads disableQrLogin into the Open Platform automation', () => {
    expect(region).toContain('disableQrLogin: opts?.disableQrLogin,');
  });

  it('skips the admin success DM when silent', () => {
    // the silent early-return must sit before getAdminOpenId is read for the DM
    const silentIdx = region.indexOf("if (opts?.silent) return { kind: 'fixed' };");
    const adminIdx = region.indexOf('const adminOpenId = getAdminOpenId(bot);');
    expect(silentIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBeGreaterThan(silentIdx);
  });

  it('does not claim success when zero scopes actually landed', () => {
    // Regression: `scopeCount` now means "how many of the MISSING ones landed",
    // so 0 most likely means "none applied" — not "nothing was missing". The old
    // single-ternary said 「所有必需权限已在应用清单中」in both cases, i.e. it
    // reported "all present" exactly when the top-up had fully failed.
    expect(region).toContain('const autoFixEffective =');
    // The three causes must be told apart: platform rejection (scopeWarning),
    // not-in-catalog (skippedScopeCount), genuinely nothing missing.
    expect(region).toContain('result.scopeWarning');
    expect(region).toContain('result.skippedScopeCount > 0');
    // ...and the honest branch must not reuse the "already present" wording.
    const ineffectiveIdx = region.indexOf('0 项权限已导入');
    expect(ineffectiveIdx, 'no explicit "0 项权限已导入" wording for the failed case').toBeGreaterThanOrEqual(0);
  });

  it('downgrades the log level and the DM headline when nothing landed', () => {
    // A failed top-up must not log `succeeded` at info, nor open the admin DM
    // with 「✅ 已自动修复了缺失的权限」— that headline is what makes an admin
    // stop looking, and this path (missing CRITICAL scopes) is the one that most
    // needs a human.
    expect(region).toContain('logger.warn(summary)');
    expect(region).toMatch(/autoFixEffective\s*$|autoFixEffective\s*\?/m);
    // 「没能全部落地」覆盖两种失败：权限一项都没申请上，以及权限进了清单但版本没提交
    // 发布（后者权限同样不生效，见 versionWarning）。原文案只说「没能申请成功」，
    // 对第二种是错的。
    expect(region).toContain('没能全部落地');
  });
});

/**
 * The 99991672 chicken-and-egg branch: the app lacks `self_manage`, so botmux
 * cannot even read its own scope list. It must still ask for every
 * botmux-required scope in one shot (so the NEXT restart's self-check passes),
 * but must not fall back to the full 300+ manifest.
 *
 * Source-region pinned for the same reason as above (checkRequiredScopes is a
 * network-driven function); the automation-side filtering itself is covered
 * behaviorally in test/setup-open-platform-automation.test.ts.
 */
describe('checkRequiredScopes — 审核中：提示人工 + 按待审版本节流', () => {
  const region = fnRegionUntil(
    "    if (autoFixed.kind === 'under_review') {",
    '本次不重复打扰',
  );

  it('🔴 按待审版本节流，且状态落盘（不是内存态）', () => {
    // 内存态每次 daemon 重启清零 ⟹ 卡 N 天发 N 条同样的 DM = 把要消灭的刷屏换个文案
    // 请回来。所以必须走落盘 store，key 用待审版本 id。
    expect(region).toContain('wasPendingReviewNotified(');
    expect(region).toContain('config.session.dataDir');
    expect(region).toContain('autoFixed.inReviewVersionId');
  });

  it('🔴 只有 DM 发送成功才记账（先记后发 = 一次失败就永久静默）', () => {
    const dmIdx = region.indexOf('const delivered = await dmAdmin(');
    const markIdx = region.indexOf('markPendingReviewNotified(');
    expect(dmIdx, '要拿 dmAdmin 的返回值').toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(dmIdx);
    // 记账必须在 delivered 为真的分支里
    expect(region).toMatch(/if \(delivered\) \{[\s\S]*markPendingReviewNotified\(/);
  });

  it('不说「等审批通过」，改为给人工修配置的可执行路径', () => {
    // 触发审批通常意味着有配置不合规，那一版不会自己通过 —— 说「等」就是让人干等
    expect(region).toMatch(/为什么会进审核/);
    expect(region).toContain('Withdraw');
    expect(region).toMatch(/直接撤回重提\*\*不管用\*\*/);
    // 也要否掉「去权限管理页手动开通」这条无效路径
    expect(region).toMatch(/手动点开通也\*\*无效\*\*/);
  });

  it('带上实测线索（数据范围现状 / 审批规则原文），而不是只转述可能原因', () => {
    expect(region).toContain('inspectUnderReviewConfigHints(');
  });
});

describe('checkRequiredScopes — 99991672 chicken-and-egg scope request set', () => {
  // 截到该分支真正的结尾（发完 self_manage 提示 DM 的那一句），同样不用固定字符宽度。
  const region = fnRegionUntil('if (infoData.code === 99991672) {', "'self_manage scope (auto-approved) missing'");

  it('asks for every botmux-required scope, not just self_manage', () => {
    // Passing only self_manage used to be cosmetic: the param never reached the
    // request set (automation fell back to the full manifest), it only fed the
    // log/DM text. Now that the manifest IS derived from these names, the list
    // has to be the real one or the next restart still finds scopes missing.
    expect(region).toMatch(/const requiredNow = BOTMUX_REQUIRED_SCOPES\.map\(s => \(\{ name: s\.name, desc: s\.desc \}\)\)/);
    expect(region).toContain('tryAutoFixScopes(larkAppId, bot, brand, requiredNow, [])');
  });

  it('still only runs on feishu and falls through to the manual deep-link DM', () => {
    expect(region).toContain("if (brand === 'feishu') {");
    // 自愈成功**或**「应用正在审核中」都直接返回：审核期间开放平台锁写，把 self_manage
    // 深链推给管理员是错误建议（点了也开不了），等审批通过下次重启自检即可。
    expect(region).toContain("if (fixed.kind !== 'failed') return;");
    expect(region).toContain('buildScopeDeepLink(bot.config.larkAppId, SELF_MANAGE_SCOPE, brand)');
  });
});

describe('ensureVcMeetingEventsSubscribed — startup VC-event check-then-configure', () => {
  // 截到该函数体真正的结尾（DM 的 contextTag），不用固定字符宽度 —— 本轮 C 修复给这个
  // 函数加了 ~10 行，最紧的断言距 3200 尾只剩 633 字符，下一次改动就会咬到。
  const region = fnRegionUntil(
    'export async function ensureVcMeetingEventsSubscribed(',
    "'vc event auto-subscribe deferred (under review)'",
  );

  it('skips non-feishu, apiOnly, and VC-inactive bots (active-config gate)', () => {
    expect(region).toContain("if (brand !== 'feishu') return;");
    // vcMeetingAgentConfigActive fail-closes apiOnly AND enabled:false, so this
    // one guard covers both "no Feishu VC" cases.
    expect(region).toContain('if (!vcMeetingAgentConfigActive(bot.config)) return;');
  });

  it('probes read-only FIRST, then only auto-subscribes when events are missing', () => {
    const probeIdx = region.indexOf('await probeVcMeetingEventSubscription(larkAppId)');
    const gateIdx = region.indexOf('probe.missingVcEvents.length === 0 && probe.eventModeReady');
    const automationIdx = region.indexOf('await automateOpenPlatformSetup(');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    // the "already subscribed → return" gate sits BETWEEN the probe and the
    // publishing automation, so a satisfied bot never republishes.
    expect(gateIdx).toBeGreaterThan(probeIdx);
    expect(automationIdx).toBeGreaterThan(gateIdx);
  });

  it('never pops a QR at boot (disableQrLogin into the publishing automation)', () => {
    expect(region).toContain('disableQrLogin: true,');
  });

  it('degrades gracefully when the probe fails (log, no throw, no QR)', () => {
    // probe.ok === false → info log + early return BEFORE any automation call
    const probeFailIdx = region.indexOf('if (!probe.ok) {');
    const automationIdx = region.indexOf('await automateOpenPlatformSetup(');
    expect(probeFailIdx).toBeGreaterThanOrEqual(0);
    expect(probeFailIdx).toBeLessThan(automationIdx);
    expect(region).toContain('botmux setup');
  });

  /**
   * 审核中（`app_under_review`）的建议必须是**「需人工修配置后撤回重提」**，两种说法都
   * 不许出现：
   *   • 「刷新登录态」—— 审核锁住的是配置写入，不是 session 问题，刷了没用
   *   • 「等审批通过就好」—— 触发审批通常意味着有配置不合规，那一版**不会自己通过**，
   *     说「等」等于让人干等（这条是上一版的措辞，在前提被纠正后反了）
   */
  it('审核中给「人工修配置后撤回重提」，不给「刷新登录态」也不说「等审批通过」', () => {
    expect(region).toContain("result.reason === 'app_under_review'");
    // 审核中走 info 而不是 warn：这是等人处理的状态，不该每次重启报错刷屏
    expect(region).toContain('VC event auto-subscribe deferred (app under review)');
    // 必须给出可执行路径
    expect(region).toContain('Withdraw');
    expect(region).toMatch(/修掉不合规项/);
    // 必须显式否掉两条无效建议
    expect(region).toMatch(/刷新登录态无效/);
    expect(region).toMatch(/不改配置直接撤回重提会被同一条规则再拦/);
    // 非审核中的路径仍保留「刷新登录态」那条（它对 session 失效才是对的）
    expect(region).toContain('刷新飞书开放平台登录态');
  });

  it('DMs the admin only when the auto-subscribe actually fails', () => {
    const failIdx = region.indexOf('VC event auto-subscribe failed');
    const dmIdx = region.indexOf('await dmAdmin(');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(dmIdx).toBeGreaterThan(failIdx);
  });
});

describe('daemon startup wires the VC-event check behind !cfg.apiOnly', () => {
  const daemonSrc = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

  it('calls ensureVcMeetingEventsSubscribed non-blocking inside the !cfg.apiOnly block', () => {
    const guardIdx = daemonSrc.indexOf('checkRequiredScopes(cfg.larkAppId).catch');
    const vcIdx = daemonSrc.indexOf('ensureVcMeetingEventsSubscribed(cfg.larkAppId).catch');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    // sits right after the scope check, sharing the same !cfg.apiOnly gate
    expect(vcIdx).toBeGreaterThan(guardIdx);
  });
});
