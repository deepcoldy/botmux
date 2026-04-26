/**
 * 图文混排 E2E：验证 botmux-send skill 的 description / 示例改动到位后，
 * 模型在被要求"图文混排"时会用 `botmux send --images <p1> --images <p2>`
 * + `![](img:0)` / `![](img:1)` 占位符把图片穿插进 markdown 正文，
 * 而不是退回 feishu-cli 创建一篇飞书文档。
 *
 * 测试流程：
 *  1. 现场用 @napi-rs/canvas 生成两张带可识别色块和文字的 PNG（橙色 TREND、蓝色 DETAIL）
 *  2. 在 Claude 私聊里发一条用自然语言描述"穿插位置"的 prompt（**不**告诉模型占位符语法）
 *  3. 等流式卡片出现 → 等 CLI 进入"等待输入"
 *  4. 校验最终 Lark 卡片：含 ACK 唯一标识 + 含 botmux 脚注 + 两张图穿插在文字之间
 *
 * 这个 case 等价于"模型必须主动加载 botmux-send skill 并按 skill 里的示例办事"。
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  sendMessage,
  navigateToMessenger,
  openChat,
  waitForStreamingCard,
  waitForCardStatus,
  scrollThreadToBottom,
  closeSession,
} from './helpers.js';

function makeImage(label: string, fillColor: string, outPath: string): void {
  const canvas = createCanvas(320, 200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, 320, 200);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 160, 100);
  writeFileSync(outPath, canvas.toBuffer('image/png'));
}

describe('botmux send 图文混排（image+text mixing via ![](img:N)）', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;
  let fixturesDir: string;
  let img1Path: string;
  let img2Path: string;
  const ts = Date.now();
  const tag = `e2e-img-mix-${ts}`;
  const ack = `ACK-${tag}`;

  beforeAll(async () => {
    checkPrerequisites();
    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        'storageState.json not found. Run: pnpm test:e2e-browser:setup',
      );
    }

    fixturesDir = join(tmpdir(), `botmux-e2e-imgmix-${ts}`);
    mkdirSync(fixturesDir, { recursive: true });
    img1Path = join(fixturesDir, 'trend.png');
    img2Path = join(fixturesDir, 'detail.png');
    // Two visually distinct images so a vision model can verify
    // ordering inside the rendered Lark card.
    makeImage('TREND', '#d35400', img1Path);
    makeImage('DETAIL', '#2980b9', img2Path);

    browser = await createBrowser();
    ({ context, page } = await createPage(browser));
    agent = createAgent(page);
  });

  afterAll(async () => {
    try {
      await closeSession(agent, page);
    } catch { /* ignore */ }
    await agent?.destroy();
    await context?.close();
    await browser?.close();
    if (fixturesDir && existsSync(fixturesDir)) {
      try { rmSync(fixturesDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('模型用 botmux send + ![](img:N) 占位符把两张图穿插进 markdown 正文', async () => {
    await navigateToMessenger(page);
    await openChat(page, agent, 'Claude');

    // 自然语言描述要求；故意不在 prompt 里给出 `![](img:N)` 占位符语法，
    // 让模型必须从 botmux-send skill 里学到怎么做。
    const prompt =
      `${tag} 我要验证 botmux send 的图文混排能力。` +
      `请用 botmux send 发一条卡片消息（不要用 feishu-cli 创建飞书文档），标题写「销售报告 ${ack}」。` +
      `两张本地图片要穿插在 markdown 正文之间——第一张橙色趋势图 ${img1Path} 紧跟在「第一张是趋势图：」这段文字后面；` +
      `第二张蓝色明细图 ${img2Path} 紧跟在「明细见下表：」这段文字后面；最后再加一句「环比 +12%」。` +
      `关键要求：两张图必须穿插在正文中间的对应位置，不能两张都堆在消息最末尾。发完就结束本轮工作。`;

    await sendMessage(agent, prompt);

    await waitForStreamingCard(agent, {
      timeoutMs: 90_000,
      msgHint: prompt,
      page,
    });

    await scrollThreadToBottom(agent);
    await waitForCardStatus(agent, '等待输入', { timeoutMs: 240_000 });

    // 主断言：模型最终发出的 Lark 卡片格式正确——
    //  (a) 含 ACK 唯一标识 → 证明这条卡片就是这次测试触发的，不是历史消息
    //  (b) 含 "botmux" 脚注 → 证明走的是 botmux send 卡片渲染（feishu-cli 不会带）
    //  (c) 两张图穿插在文字之间，从上到下顺序为「趋势」段 → 橙图 → 「明细」段 → 蓝图 → 「环比」
    //  这同时排除"两张图都堆在末尾"（说明没用占位符）和"用 feishu-cli 文档代替"两种失败模式
    await scrollThreadToBottom(agent);
    await agent.aiAssert(
      `主内容区正在显示的测试话题里出现一条来自 Claude 的卡片消息（不是流式状态卡片、不是仓库选择卡），` +
        `卡片标题或正文包含字符串 "${ack}"；` +
        `卡片正文从上到下依次出现：「销售报告」字样 → 「趋势」相关文字 → 一张橙色背景、白字写着 TREND 的图 → 「明细」相关文字 → 一张蓝色背景、白字写着 DETAIL 的图 → 「环比」或「+12%」字样；` +
        `两张图必须分别穿插在文字段落之间（橙图在「趋势」之后、蓝图在「明细」之后），` +
        `**不能**两张图都堆在卡片末尾、也**不能**只出现一张图；` +
        `卡片底部小字脚注必须能看到 "botmux" 字样（这是 botmux send 的特征签名）；` +
        `不应该出现"飞书文档已创建"、"https://*.feishu.cn/docx/" 之类 feishu-cli 创建文档的提示`,
    );
  }, 360_000);
});
