import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocCommentFailures } from '../src/dashboard/web/doc-comment-failures.js';
import { failedDocWatches, type DocWatchBotResult } from '../src/dashboard/web/doc-watches.js';
import { ui } from '../src/dashboard/web/ui.js';

const FAILED_WATCH = {
  fileToken: 'DocToken1234567890123456', fileType: 'docx', docTitle: '插件周报指标建设',
  commentTriggerMode: 'mention-only' as const, managedBy: 'watch-comment' as const,
  createdAt: 1, lastActivityAt: 2, lastOutcome: 'no-comment' as const,
  lastError: 'Access denied (code: 1069303)', dispatchCount: 0,
};
const RESULT: DocWatchBotResult = { larkAppId: 'app-codex', botName: 'CodexOG', watches: [FAILED_WATCH] };

describe('document failures alongside sessions', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  beforeEach(() => {
    ui.authed = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
      setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
  });
  afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    ui.authed = true;
    vi.unstubAllGlobals();
  });

  it('renders a failed comment without a session ID, with the provider reason and document link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => url === '/api/bots'
        ? { bots: [{ larkAppId: RESULT.larkAppId, botName: RESULT.botName }] }
        : { watches: RESULT.watches },
    })));
    await act(async () => { renderer = TestRenderer.create(React.createElement(DocCommentFailures)); });
    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain('CodexOG');
    expect(rendered).toContain(FAILED_WATCH.lastError);
    expect(renderer!.root.findAllByType('a').map(link => link.props.href)).toContain('#/doc-watches');
    expect(renderer!.root.findAllByType('a').map(link => link.props.href)).toContain(`https://feishu.cn/docx/${FAILED_WATCH.fileToken}`);
  });

  it('does not query or expose document diagnostics to a read-only visitor', async () => {
    ui.authed = false;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await act(async () => { renderer = TestRenderer.create(React.createElement(DocCommentFailures)); });
    expect(renderer!.toJSON()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not describe an unavailable bot query as a successful empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: url === '/api/bots', status: url === '/api/bots' ? 200 : 503,
      json: async () => url === '/api/bots'
        ? { bots: [{ larkAppId: RESULT.larkAppId }] }
        : { error: 'daemon unavailable' },
    })));
    await act(async () => { renderer = TestRenderer.create(React.createElement(DocCommentFailures)); });
    expect(renderer!.root.findByProps({ role: 'status' })).toBeDefined();
    expect(renderer!.root.findAllByType('li')).toHaveLength(0);
  });

  it('excludes successful and unrelated comments, preserves bot identity and sorts failures by recency', () => {
    const rows = failedDocWatches([
      { ...RESULT, watches: [FAILED_WATCH, { ...FAILED_WATCH, fileToken: 'success', lastOutcome: 'dispatched' },
        { ...FAILED_WATCH, fileToken: 'unrelated', lastOutcome: 'not-mentioned' }] },
      { larkAppId: 'app-other', botName: 'Other', watches: [{ ...FAILED_WATCH, lastActivityAt: 3 }] },
    ]);
    expect(rows.map(row => row.larkAppId)).toEqual(['app-other', 'app-codex']);
    expect(rows).toHaveLength(2);
  });
});
