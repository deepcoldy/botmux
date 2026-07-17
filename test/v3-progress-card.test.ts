import { describe, expect, it } from 'vitest';

import {
  buildV3ProgressCard,
  v3ProgressRunDetailUrl,
} from '../src/im/lark/v3-progress-card.js';
import type { V3RunSaveActionValue } from '../src/im/lark/v3-run-save-card.js';
import type { V3ProgressView } from '../src/workflows/v3/progress-projection.js';

function baseView(overrides: Partial<V3ProgressView> = {}): V3ProgressView {
  return {
    runId: 'weekly-report-260711-120000-ab12cd34',
    status: 'running',
    source: { kind: 'ad_hoc' },
    counts: {
      total: 6,
      done: 2,
      running: 1,
      waiting: 1,
      blocked: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      pending: 2,
    },
    currentNodeIds: ['collect-data'],
    waitingNodeIds: ['human-review'],
    loops: [{
      loopId: 'quality-loop',
      iteration: 2,
      maxIterations: 3,
      granted: 1,
      lastDecision: 'continue',
    }],
    revisit: { count: 1, refreshedNodeIds: ['draft'] },
    updatedAt: '2026-07-11T12:34:56.000Z',
    ...overrides,
  };
}

function parse(view: V3ProgressView, webDetailUrl = 'https://example.test/v3/run'): any {
  return JSON.parse(buildV3ProgressCard(view, { webDetailUrl }));
}

function allText(card: unknown): string {
  return JSON.stringify(card);
}

describe('buildV3ProgressCard', () => {
  it('运行态展示状态、进度、当前节点、等待、循环、回访、来源、runId、更新时间和详情入口', () => {
    const card = parse(baseView());
    const text = allText(card);

    expect(card.header).toEqual({
      template: 'blue',
      title: { tag: 'plain_text', content: '🔄 Workflow v3 · 运行中' },
    });
    expect(text).toContain('2 / 6 节点完成');
    expect(text).toContain('collect-data');
    expect(text).toContain('human-review');
    expect(text).toContain('quality-loop');
    expect(text).toContain('第 2 / 4 轮');
    expect(text).toContain('已追加 1 轮');
    expect(text).toContain('继续');
    expect(text).toContain('回访');
    expect(text).toContain('刷新 draft');
    expect(text).toContain('即兴编排');
    expect(text).toContain('weekly-report-260711-120000-ab12cd34');
    expect(text).toContain('/workflow cancel weekly-report-260711-120000-ab12cd34');
    expect(text).toContain('更新时间：2026-07-11 12:34:56Z');

    const detail = card.elements.find(
      (element: any) => element.tag === 'action' && element.actions?.[0]?.multi_url,
    ).actions[0];
    expect(detail.text.content).toBe('Web 详情（需登录）');
    expect(detail.multi_url).toEqual({
      url: 'https://example.test/v3/run',
      pc_url: 'https://example.test/v3/run',
      android_url: 'https://example.test/v3/run',
      ios_url: 'https://example.test/v3/run',
    });
  });

  it.each([
    ['starting', 'blue', '⏳ Workflow v3 · 准备中'],
    ['cancelling', 'orange', '⏹ Workflow v3 · 取消中'],
    ['cancelled', 'grey', '⏹ Workflow v3 · 已取消'],
    ['waiting', 'orange', '⏸ Workflow v3 · 等待中'],
    ['blocked', 'orange', '🚧 Workflow v3 · 已阻塞'],
    ['succeeded', 'green', '✅ Workflow v3 · 已完成'],
    ['failed', 'red', '❌ Workflow v3 · 失败'],
  ] as const)('%s 状态使用 %s 卡头', (status, template, title) => {
    const card = parse(baseView({ status }));
    expect(card.header.template).toBe(template);
    expect(card.header.title.content).toBe(title);
  });

  it('取消时显式提示外部效果待核实，不泄露具体 payload', () => {
    const text = allText(parse(baseView({
      status: 'cancelled',
      uncertainHostEffectCount: 2,
      currentNodeIds: [],
      waitingNodeIds: [],
    })));
    expect(text).toContain('外部效果待核实');
    expect(text).toContain('2 个外部操作');
    expect(text).toContain('不要直接重试');
  });

  it('进度把 skipped/cancelled 计为已完成，分母仍是固定外层节点数', () => {
    const card = parse(baseView({
      status: 'succeeded',
      counts: {
        total: 6, done: 2, running: 0, waiting: 0, blocked: 0, failed: 0,
        skipped: 2, cancelled: 1, pending: 1,
      },
    }));
    expect(allText(card)).toContain('5 / 6 节点完成');
  });

  it('ad_hoc 成功时展示可复制的 save 命令，非成功态不展示', () => {
    const succeeded = allText(parse(baseView({
      status: 'succeeded',
      currentNodeIds: [],
      waitingNodeIds: [],
      loops: [],
      revisit: { count: 0, refreshedNodeIds: [] },
    })));
    expect(succeeded).toContain('/workflow save weekly-report-260711-120000-ab12cd34 [名称]');

    const running = allText(parse(baseView()));
    expect(running).not.toContain('/workflow save');
  });

  it('ad_hoc 成功时只渲染调用方准备的本群保存 action，不自行构造 nonce', () => {
    const view = baseView({ status: 'succeeded' });
    const chat: V3RunSaveActionValue = {
      action: 'v3_run_save',
      runId: view.runId,
      scope: 'chat',
      nonce: 'trusted-chat-nonce',
    };
    const card = JSON.parse(buildV3ProgressCard(view, {
      webDetailUrl: 'https://example.test/v3/run',
      saveActions: { chat },
    }));
    const saveButtons = card.elements
      .filter((element: any) => element.tag === 'action')
      .flatMap((element: any) => element.actions)
      .filter((action: any) => action.value?.action === 'v3_run_save');

    expect(saveButtons.map((button: any) => button.text.content)).toEqual(['保存到本群']);
    expect(saveButtons.map((button: any) => button.value)).toEqual([chat]);
    expect(allText(card)).toContain('/workflow save');
  });

  it('保存按钮仅在 ad_hoc 成功态出现，全局发布保留给显式命令', () => {
    const chat: V3RunSaveActionValue = {
      action: 'v3_run_save',
      runId: 'weekly-report-260711-120000-ab12cd34',
      scope: 'chat',
      nonce: 'chat-only',
    };
    const opts = { webDetailUrl: 'https://example.test/v3/run', saveActions: { chat } };

    const succeeded = allText(JSON.parse(buildV3ProgressCard(baseView({ status: 'succeeded' }), opts)));
    expect(succeeded).toContain('保存到本群');
    expect(succeeded).not.toContain('保存为');

    const running = allText(JSON.parse(buildV3ProgressCard(baseView(), opts)));
    expect(running).not.toContain('保存到本群');

    const saved = allText(JSON.parse(buildV3ProgressCard(baseView({
      status: 'succeeded',
      source: {
        kind: 'saved_definition',
        workflowId: 'weekly-report',
        humanVersion: 1,
        revisionId: 'sha256:revision',
      },
    }), opts)));
    expect(saved).not.toContain('保存到本群');
  });

  it('卡头安全清理并截断 spec title', () => {
    const card = parse(baseView({
      title: `  周报\n汇总\u0000${'🚀'.repeat(61)}  `,
    }));
    const title = card.header.title.content as string;
    expect(title).toMatch(/^🔄 周报 汇总 🚀+/u);
    expect(title).toContain('… · 运行中');
    expect(title).not.toContain('\n');
    expect(title).not.toContain('\u0000');
    expect(title).not.toContain('\uFFFD');
  });

  it('saved_definition 成功时展示来源和无参数值的 rerun 命令', () => {
    const view = baseView({
      status: 'succeeded',
      source: { kind: 'saved_definition', workflowId: 'weekly-report', humanVersion: 3 },
      currentNodeIds: [],
      waitingNodeIds: [],
      loops: [],
      revisit: { count: 0, refreshedNodeIds: [] },
    }) as V3ProgressView & { params?: Record<string, string> };
    // Defense-in-depth assertion: even an accidental wider object passed by a
    // caller is rendered through the allowlisted V3ProgressView fields only.
    view.params = { token: 'TOP_SECRET', region: 'prod' };

    const text = allText(parse(view));
    expect(text).toContain('已保存');
    expect(text).toContain('weekly-report');
    expect(text).toContain('v3');
    expect(text).toContain('/workflow run weekly-report');
    expect(text).not.toContain('TOP_SECRET');
    expect(text).not.toContain('region');
    expect(text).not.toContain('prod');
  });

  it('失败/阻塞只展示结构化错误码，不展示自由文本或其它未投影内容', () => {
    const view = baseView({
      status: 'blocked',
      issue: {
        nodeId: 'deploy',
        errorClass: 'workerError',
        errorCode: 'AUTH_REQUIRED',
      },
    }) as V3ProgressView & {
      issue: V3ProgressView['issue'] & { message?: string };
      goal?: string;
      path?: string;
    };
    view.issue.message = 'secret token abc123 at /root/private';
    view.goal = 'do not leak this goal';
    view.path = '/root/.botmux/v3-runs/private';

    const card = parse(view);
    const text = allText(card);
    expect(text).toContain('错误码');
    expect(text).toContain('deploy');
    expect(text).toContain('workerError');
    expect(text).toContain('AUTH\\\\_REQUIRED');
    expect(text).not.toContain('secret token');
    expect(text).not.toContain('do not leak');
    expect(text).not.toContain('/root/');
  });

  it('节点标识做 markdown/mention 转义，长列表折叠', () => {
    const card = parse(baseView({
      currentNodeIds: ['<at id=ou_bad>', '*bold*', 'n3', 'n4', 'n5', 'n6'],
      waitingNodeIds: [],
      loops: [],
      revisit: { count: 0, refreshedNodeIds: [] },
    }));
    const text = allText(card);
    expect(text).toContain('\\\\<at id=ou\\\\_bad\\\\>');
    expect(text).toContain('\\\\*bold\\\\*');
    expect(text).toContain('等 6 个');
    expect(text).not.toContain('n6');
  });

  it('默认详情 URL 对 runId 做 URL 编码', () => {
    const url = v3ProgressRunDetailUrl('run with space');
    expect(url).toContain('/#/v3/run%20with%20space');
  });

  it.each([
    [{ kind: 'manual_cli' } as const, '本地 CLI'],
    [{ kind: 'legacy_v3' } as const, '旧版 v3'],
  ])('来源 %o 显示为 %s', (source, label) => {
    expect(allText(parse(baseView({ source })))).toContain(label);
  });
});
