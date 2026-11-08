/**
 * 图文说明在飞书卡片和管家规则里的样子：
 *   - 卡片只提示「附了 N 个图文说明」（飞书卡片里放不了网页和视频），没有说明的事项卡片不变；
 *   - 管家规则里有附说明的一节，给的模板自己过得了看板的校验、也不触发任何提醒。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService } from '../src/core/decision-board/service.js';
import { buildDecisionCard } from '../src/core/decision-board/card.js';
import { stewardGuidePreset } from '../src/core/decision-board/model.js';
import { boardExplainerHtmlWarnings, checkBoardExplainerHtml } from '../src/core/decision-board/files.js';

const APP = 'cli_steward';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]).toString('base64');
const HTML = Buffer.from('<!doctype html><meta charset="utf-8"><h1>改前改后</h1>');
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);

let dir: string;
let service: DecisionBoardService;
let sent: any[];
let updated: any[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-explainer-card-'));
  sent = [];
  updated = [];
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => ({ enabled: true, chatId: 'oc_steward' }),
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => 'owner',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: async () => ({ sessionId: 'sess-steward' }),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: chatId }),
    cards: {
      sendCard: async (_chatId, card) => { sent.push(JSON.parse(card)); return `om_card_${sent.length}`; },
      updateCard: async (_messageId, card) => { updated.push(JSON.parse(card)); },
      isCardGone: () => false,
    },
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

function cardText(card: any): string {
  const out: string[] = [];
  const walk = (list: any[] | undefined) => {
    for (const el of list ?? []) {
      if (el.tag === 'markdown') out.push(el.content);
      walk(el.elements);
      for (const col of el.columns ?? []) walk(col.elements);
    }
  };
  walk(card.body?.elements);
  return out.join('\n');
}

async function addDecide(): Promise<number> {
  const res = await service.cli({
    action: 'add', title: 'PR #1 合不合', fields: { summary: 'CI 全绿', question: '合不合？' }, options: ['A=合', 'B=不合'], noChat: '用例',
  }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  await service.cardsIdle();
  return res.item.seq;
}

async function stage(seq: number, name: string, mime: string, data: Buffer): Promise<string> {
  const res = await service.stageExplainer({ ref: String(seq), name, mime, body: [data] }, { sessionId: 'sess-1' });
  return res.id;
}

describe('飞书卡片', () => {
  it('附上说明页和视频后卡片原地更新，带一句「附了 2 个图文说明」，其余不变', async () => {
    const seq = await addDecide();
    expect(sent).toHaveLength(1);
    expect(cardText(sent[0])).not.toContain('📎');

    const staged = [await stage(seq, 'a.html', 'text/html', HTML), await stage(seq, 'b.webm', 'video/webm', WEBM)];
    await service.cli({ action: 'attach', ref: String(seq), staged }, { sessionId: 'sess-1' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
    expect(updated).toHaveLength(1);
    const after = updated[0];
    expect(cardText(after)).toMatch(/📎[^\n]*2/);
    // 这一句跟在「现状」后面、同一个 markdown 块里；去掉它，其余和原来的卡片一样。
    expect(JSON.stringify(after).replace(/\\n📎[^"\\]*/, '')).toBe(JSON.stringify(sent[0]));
  });

  it('只附截图：卡片不提图文说明，也不重发', async () => {
    const seq = await addDecide();
    await service.cli({ action: 'attach', ref: String(seq), files: [{ name: 's.png', mimeType: 'image/png', dataBase64: PNG }] }, { sessionId: 'sess-1' });
    await service.cardsIdle();
    expect(sent).toHaveLength(1);
    for (const card of updated) expect(cardText(card)).not.toContain('📎');
  });

  it('没有说明时 buildDecisionCard 的输出与不传这个字段完全一致；英文卡片也有这一句', () => {
    const item = { seq: 9, title: 't', state: 'decide' as const, question: 'q?', options: [{ key: 'A', label: 'a' }], rev: 1, createdAt: 1, updatedAt: 1, stateAt: 1 };
    const base = { appId: APP, locale: 'zh' as const, item, links: {} };
    expect(buildDecisionCard({ ...base, explainers: 0 })).toEqual(buildDecisionCard(base));
    expect(cardText(buildDecisionCard({ ...base, locale: 'en', explainers: 1 }))).toMatch(/📎[^\n]*1/);
    expect(cardText(buildDecisionCard({ ...base, retired: 'disabled', explainers: 3 }))).toMatch(/📎[^\n]*3/);
  });
});

describe('管家规则', () => {
  const template = (guide: string) => /```html\n([\s\S]*?)\n```/.exec(guide)?.[1] ?? '';

  it.each(['zh', 'en'] as const)('%s：规则里给了附说明的 attach 命令', locale => {
    expect(stewardGuidePreset(locale)).toMatch(/botmux board attach \S+ \S+\.html/);
  });

  it.each(['zh', 'en'] as const)('%s：模板过得了看板的校验，没有外链和脚本，图片用 data URL', locale => {
    const html = template(stewardGuidePreset(locale));
    expect(html).toMatch(/^<!doctype html>/);
    const checked = checkBoardExplainerHtml(Buffer.from(html));
    expect(checked.ok).toBe(true);
    expect(boardExplainerHtmlWarnings(html)).toEqual([]);
    expect(html).not.toMatch(/https?:/);
    expect(html.match(/<img [^>]*src="([^"]*)"/g)?.every(tag => tag.includes('src="data:image/'))).toBe(true);
  });
});
