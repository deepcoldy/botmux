/**
 * Unit tests for buildTopicThreadContext — the first-turn helper that injects a
 * lightweight *hint* (not the full transcript, and with ZERO network fetch) for
 * a 普通群 topic the bot otherwise wouldn't know exists. The hint points the CLI
 * at `botmux history` for on-demand retrieval, mirroring the quote-hint pattern.
 *
 * The function is now pure + synchronous: it takes only a locale and renders the
 * localized hint. It performs no Lark API calls at all — the daemon gate already
 * proved this is a topic reply, so there's nothing to probe. These tests lock
 * that contract: the hint wording is right, it carries no transcript, and NONE
 * of the (previously used) network helpers are ever invoked.
 *
 * Run:  pnpm vitest run test/topic-root-context.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the (previously used) network / side-effecting deps purely to ASSERT
// they are never called — the hint approach must do zero first-turn fetch.
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: vi.fn(),
  listThreadMessages: vi.fn(),
}));
vi.mock('../src/im/lark/merge-forward.js', () => ({
  expandMergeForward: vi.fn(),
}));
vi.mock('../src/core/session-manager.js', () => ({
  downloadResources: vi.fn(),
  formatAttachmentsHint: vi.fn(() => ''),
}));

import { buildTopicThreadContext } from '../src/im/lark/topic-root-context.js';
import { getMessageDetail, listThreadMessages } from '../src/im/lark/client.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { downloadResources } from '../src/core/session-manager.js';

const getMessageDetailMock = getMessageDetail as unknown as ReturnType<typeof vi.fn>;
const listThreadMessagesMock = listThreadMessages as unknown as ReturnType<typeof vi.fn>;
const expandMergeForwardMock = expandMergeForward as unknown as ReturnType<typeof vi.fn>;
const downloadResourcesMock = downloadResources as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getMessageDetailMock.mockReset();
  listThreadMessagesMock.mockReset();
  expandMergeForwardMock.mockReset();
  downloadResourcesMock.mockReset();
});

describe('buildTopicThreadContext (hint mode, zero-fetch)', () => {
  it('emits a hint that points the CLI at botmux history', () => {
    const out = buildTopicThreadContext();
    expect(out).toContain('话题');
    expect(out).toContain('botmux history');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is a HINT, not a transcript: carries no count and no message bodies/senders', () => {
    const out = buildTopicThreadContext();
    // No exact count is claimed (the old {count} floor-count is gone).
    expect(out).not.toMatch(/\d+\s*条/);
    expect(out).not.toContain(':'); // no "sender: body" transcript lines
  });

  it('performs ZERO first-turn network fetch (the core of the P2 fix)', () => {
    buildTopicThreadContext();
    expect(listThreadMessagesMock).not.toHaveBeenCalled();
    expect(getMessageDetailMock).not.toHaveBeenCalled();
    expect(expandMergeForwardMock).not.toHaveBeenCalled();
    expect(downloadResourcesMock).not.toHaveBeenCalled();
  });

  it('is synchronous (returns a string, not a Promise)', () => {
    const out = buildTopicThreadContext();
    expect(typeof out).toBe('string');
  });

  it('renders the English hint under an en locale', () => {
    const out = buildTopicThreadContext('en');
    expect(out).toContain('botmux history');
    expect(out.toLowerCase()).toContain('topic');
  });
});
