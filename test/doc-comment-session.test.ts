import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import {
  docCommentAnchor,
  docCommentTempDir,
  resolveDocCommentSessionPolicy,
  safeDocSessionSegment,
} from '../src/services/doc-comment-session.js';

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    larkAppId: 'cli_test',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    ...overrides,
  };
}

describe('doc-comment session policy', () => {
  it('uses one stable anchor per document', () => {
    expect(docCommentAnchor('cli_a', 'doccn_xxx')).toBe('doc:cli_a:doccn_xxx');
  });

  it('builds stable filesystem-safe temp directories', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-doc-session-'));
    const dir = docCommentTempDir(dataDir, 'cli/unsafe', 'doc/token?x');

    expect(dir).toContain(dataDir);
    expect(dir).toContain(safeDocSessionSegment('cli/unsafe'));
    expect(dir).toContain(safeDocSessionSegment('doc/token?x'));
  });

  it('rejects events while the entrypoint is disabled', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: false, files: [{ fileToken: 'doc_1' }] } }),
      { fileToken: 'doc_1', commentId: 'c_1' },
      { dataDir: '/tmp/botmux' },
    );

    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('allows any document token for bot operators', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [] } }),
      { fileToken: 'doc_2', commentId: 'c_1', authorOpenId: 'ou_operator' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result.ok).toBe(true);
  });

  it('maps bot operators to talk-only temp sessions by default', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [{ fileToken: 'doc_1' }] } }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_operator' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workingDirSource).toBe('temp');
      expect(result.workingDir).toBe(docCommentTempDir('/tmp/botmux', 'cli_test', 'doc_1'));
      expect(result.canTalk).toBe(true);
      expect(result.canOperate).toBe(false);
    }
  });

  it('honors per-document kill switches', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [{ fileToken: 'doc_1', enabled: false }] } }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_operator' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result).toEqual({ ok: false, reason: 'file_disabled' });
  });

  it('rejects authors without bot operation permission when a document has no additional author allowlist', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [{ fileToken: 'doc_1' }] } }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_other' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result).toEqual({ ok: false, reason: 'author_not_allowed' });
  });

  it('allows per-document additional authors', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [{ fileToken: 'doc_1', allowedAuthors: ['ou_peer'] }] } }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_peer' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result.ok).toBe(true);
  });

  it('fails closed when no operators or explicit document authors are available', () => {
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({ docComments: { enabled: true, files: [{ fileToken: 'doc_1' }] } }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_other' },
      { dataDir: '/tmp/botmux' },
    );

    expect(result).toEqual({ ok: false, reason: 'operator_not_configured' });
  });

  it('allows pinned working dirs inside configured roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-doc-root-'));
    const repo = join(root, 'repo');
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({
        workingDir: root,
        docComments: { enabled: true, files: [{ fileToken: 'doc_1', workingDir: repo }] },
      }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_operator' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workingDir).toBe(repo);
      expect(result.workingDirSource).toBe('binding');
    }
  });

  it('rejects pinned working dirs outside allowed roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-doc-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'botmux-doc-outside-'));
    const result = resolveDocCommentSessionPolicy(
      'cli_test',
      bot({
        workingDir: root,
        docComments: { enabled: true, files: [{ fileToken: 'doc_1', workingDir: outside }] },
      }),
      { fileToken: 'doc_1', commentId: 'c_1', authorOpenId: 'ou_operator' },
      { dataDir: '/tmp/botmux', operatorOpenIds: ['ou_operator'] },
    );

    expect(result).toEqual({ ok: false, reason: 'working_dir_outside_allowed_roots' });
  });
});
