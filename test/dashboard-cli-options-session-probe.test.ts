/**
 * dashboard-cli-options-session-probe.test.ts
 *
 * 钉住 `/api/cli-options` 的「登录态探测可被显式跳过」契约。
 *
 * 背景（MEASURED，本机直连 7891）：该端点原先无条件 `await
 * botOnboarding.sessionStatus()`，那是一趟到飞书开放平台的真实网络往返
 * （单独计时 1004 / 1091 / 2530ms；端点整体 p50 1282ms、max 4402ms），
 * 而同一 handler 里真正要算的东西只有 13ms（39 个 CLI 的
 * checkCliAvailability 12ms + staticModelChoices 1ms）。
 *
 * Bot 配置页在 mount 时把这个端点与 `/api/bots`（40-50ms）并行发出，首屏
 * 等在最慢那个身上；而它的 `CliOptionsState`（bot-defaults.ts）类型里没有
 * `webSession` 字段——付了 1-4s 的钱、拿到就丢。
 *
 * 契约是双向的，两边都必须钉住：
 *   A. 服务端：**裸端点保留旧语义**（照旧探测），只有显式 `?probe=none` 才
 *      跳过。方向不能反：路由 chunk 带 immutable 长缓存，而 stale-chunk 自愈
 *      只在动态 import 失败时触发，所以 dashboard 重启后已加载的旧 Bot 配置
 *      chunk 会继续请求裸端点；裸端点若默认不探测，旧 chunk 会把「字段缺席」
 *      判成 scan_required，**把登录态正常的用户推去扫码**。
 *   B. 前端：Bot 配置页显式带 `?probe=none` 走快路径；onboarding 弹窗走裸
 *      端点（它真要 webSession 来决定 reuse/qr）。
 *
 * 取舍：沿用本目录既有的 source-lock 模式（见 dashboard-cli-options-models
 * .test.ts 的说明）——dashboard.ts 是模块级 createServer 的重型模块，仓库
 * 内无任何测试整体 import 它，起全量 HTTP harness 代价过高且脆弱。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(resolve('src/dashboard.ts'), 'utf8');

/** `/api/cli-options` 路由体（到相邻的 /models 路由为止）。 */
function cliOptionsRouteBlock(): string {
  const start = dashboardSource.indexOf("url.pathname === '/api/cli-options'");
  const end = dashboardSource.indexOf("url.pathname === '/api/cli-options/models'");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return dashboardSource.slice(start, end);
}

describe('GET /api/cli-options — 服务端：登录态探测可被显式跳过', () => {
  it('sessionStatus() 由 probe 参数决定，且裸端点保留旧语义（探测）', () => {
    const block = cliOptionsRouteBlock();
    expect(block).toContain('botOnboarding.sessionStatus()');
    // 闸门存在：读 probe 查询参数
    expect(block).toContain("url.searchParams.get('probe')");
    // 关键判据不是「出现了 probe 这个名字」，而是「sessionStatus() 这个值是否
    // 由该闸门决定」。退化写法（无条件 `= await …sessionStatus()`）不含 `?`，
    // 这条会红。
    expect(block).toMatch(
      /probe\s*===\s*'none'\s*\?\s*undefined\s*:\s*await\s+botOnboarding\.sessionStatus\(\)/,
    );
    // ⚠️ 方向性判据（这个方向本身就是判据，必须钉住）：必须是 opt-OUT。
    // 若退回 opt-IN（`probe === 'session' ? await … : undefined`），
    // dashboard 重启后仍活着的旧 Bot 配置 chunk 会请求裸端点、拿不到
    // webSession、把登录态正常的用户推去扫码。
    expect(block).not.toMatch(/probe\w*\s*===\s*'session'\s*\?\s*await/);
    expect(block).not.toMatch(/=\s*await\s+botOnboarding\.sessionStatus\(\);/);
  });

  it('跳过探测时 webSession 字段整个缺席，不下发 undefined 占位', () => {
    const block = cliOptionsRouteBlock();
    expect(block).toContain('...(webSession ? { webSession } : {})');
    expect(block).not.toMatch(/^\s*webSession,\s*$/m);
  });

  it('真正的计算（CLI 可用性 + 静态模型候选）不受闸门影响，始终下发', () => {
    const block = cliOptionsRouteBlock();
    expect(block).toContain('checkCliAvailability(');
    expect(block).toContain('staticModelChoices(o.key)');
    expect(block).toContain('suggestedAppName: botOnboarding.suggestedAppName()');
  });
});

describe('前端调用方：谁跳过探测，谁保留', () => {
  it('onboarding 弹窗走裸端点（它要 webSession）', () => {
    const source = readFileSync(
      resolve('src/dashboard/web/bot-onboarding.tsx'),
      'utf8',
    );
    expect(source).toContain("fetch('/api/cli-options')");
    // 有牙：弹窗一旦跳过探测，登录态就拿不到，sessionMode 会误落 qr
    expect(source).not.toContain("/api/cli-options?probe=none");
    expect(source).toContain('webSession');
  });

  it('Bot 配置页显式 probe=none（这就是首屏 3350ms → 42ms 的来源）', () => {
    const source = readFileSync(
      resolve('src/dashboard/web/bot-defaults.ts'),
      'utf8',
    );
    expect(source).toContain("fetch('/api/cli-options?probe=none')");
    // 退化防护：本页退回裸端点，首屏又会退回 1-4s
    expect(source).not.toMatch(/fetch\('\/api\/cli-options'\)/);
    // 且本页的类型确实不含 webSession —— 证明「拿到就丢」这个前提仍然成立。
    const stateType = source.slice(
      source.indexOf('export type CliOptionsState'),
      source.indexOf('export type CliRuntimeConfig'),
    );
    expect(stateType.length).toBeGreaterThan(0);
    expect(stateType).not.toContain('webSession');
  });
});
