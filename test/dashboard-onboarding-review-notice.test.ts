/**
 * Dashboard 建 bot 的结果面板：版本卡在企业管理员审核时，必须说清是在「等审核」，
 * 不能说「已可使用 / 已提交发布」让用户以为 botmux 卡住，也不能给「手动配置 / 撤回重提」
 * 这类在审核锁下做不到或有害的建议。
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSummary, statusText } from '../src/dashboard/web/bot-onboarding.js';
import { t } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Job = Parameters<typeof statusText>[0];

const renderers: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
});

function render(job: Job) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(PermissionSummary, { job })); });
  renderers.push(renderer);
  const text = (node: TestRenderer.ReactTestInstance | string): string =>
    typeof node === 'string' ? node : node.children.map(text).join('');
  const reviewNotices = renderer.root.findAll(node => node.props['data-onboarding-review-pending'] !== undefined && typeof node.type === 'string');
  const links = renderer.root.findAllByType('a').map(a => a.props.href as string);
  return { all: text(renderer.root), reviewNotices: reviewNotices.map(text), links };
}

const completed = (permission: NonNullable<Job['permission']>, extra: Partial<Job> = {}): Job => ({
  id: 'job', status: 'completed', appId: 'cli_new', appName: 'botmux-7', permission, ...extra,
});

describe('onboarding result when the version waits for enterprise review', () => {
  it('says the submitted version is waiting for review, with its version and approvers', () => {
    const job = completed({
      ok: true, scopeCount: 120, versionId: 'opaque-version-id',
      versionPendingReview: true, pendingReviewAppVersion: '1.0.1', approvalHumanApprovers: ['审批人甲'],
    });
    const view = render(job);
    expect(view.reviewNotices).toHaveLength(1);
    expect(view.reviewNotices[0]).toContain('1.0.1');
    expect(view.reviewNotices[0]).toContain('审批人甲');
    // 「在等审核」之外还要说清卡住/被驳回时怎么办：审批是规则驱动的，可能因配置不合规一直不过。
    expect(view.reviewNotices[0]).toContain(t('botOnboarding.reviewStuckHint'));
    // 不再出「已提交发布版本 <id>」那句——等审核时它会被读成「已经生效」。
    expect(view.all).not.toContain('opaque-version-id');
    expect(statusText(job)).not.toBe(statusText(completed({ ok: true, scopeCount: 120, versionId: 'opaque-version-id' })));
    expect(statusText(job)).toContain('botmux-7');
  });

  it('shows a review notice instead of manual / withdraw advice when the app config is review-locked', () => {
    const withdrawAdvice = '撤回该待审版本 → 重新提交';
    const job = completed(
      { ok: false, reason: 'app_under_review', message: `应用正在飞书审核中……${withdrawAdvice}` },
      { remainingSteps: [{ title: '申请权限', url: 'https://open.feishu.cn/app/cli_new/auth' }] },
    );
    const view = render(job);
    expect(view.reviewNotices).toHaveLength(1);
    expect(view.reviewNotices[0]).toContain(t('botOnboarding.reviewStuckHint'));
    // 不把 automation 那段长说明原样贴出来（它面向日志，且把审核一律说成配置不合规）。
    expect(view.all).not.toContain(withdrawAdvice);
    // 审核通过后还要补齐的配置仍然列出来。
    expect(view.links).toEqual(['https://open.feishu.cn/app/cli_new/auth']);
    expect(statusText(job)).toBe(statusText(completed({
      ok: true, scopeCount: 1, versionPendingReview: true, pendingReviewAppVersion: '1.0.1',
    })));
  });

  it('keeps the normal summary when nothing waits for review', () => {
    const ok = completed({ ok: true, scopeCount: 120, versionId: 'opaque-version-id' });
    const okView = render(ok);
    expect(okView.reviewNotices).toEqual([]);
    expect(okView.all).toContain('opaque-version-id');

    const failedMessage = '开放平台自动配置失败: code=1';
    const failed = render(completed(
      { ok: false, reason: 'api_error', message: failedMessage },
      { remainingSteps: [{ title: '申请权限', url: 'https://open.feishu.cn/app/cli_new/auth' }] },
    ));
    expect(failed.reviewNotices).toEqual([]);
    expect(failed.all).toContain(failedMessage);
  });
});
