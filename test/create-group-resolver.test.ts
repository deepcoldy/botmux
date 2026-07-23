/**
 * Unit tests for `botmux create-group` bot ref resolver.
 *
 * Pure function — no I/O involved. Tests cover:
 *  - larkAppId direct match
 *  - botName case-insensitive match
 *  - cliId fallback when botName is unknown (fresh CLI, no bots-info.json yet)
 *  - same name in multiple configs → pick first in bots.json order + warning
 *  - duplicate refs → dedup, keep first occurrence
 *  - unresolvable refs → reported in `invalid`
 */
import { describe, it, expect } from 'vitest';
import { resolveBotRefs, resolveKickoff } from '../src/cli/create-group-resolver.js';

const CFG_CLAUDE = { larkAppId: 'cli_claude_1', cliId: 'claude-code' };
const CFG_COCO_1 = { larkAppId: 'cli_coco_1', cliId: 'claude-code' };
const CFG_COCO_2 = { larkAppId: 'cli_coco_2', cliId: 'claude-code' };
const CFG_CODEX = { larkAppId: 'cli_codex_1', cliId: 'codex' };

const INFO_CLAUDE = { larkAppId: 'cli_claude_1', botName: 'Claude' };
const INFO_COCO_1 = { larkAppId: 'cli_coco_1', botName: 'CoCo' };
const INFO_COCO_2 = { larkAppId: 'cli_coco_2', botName: 'CoCo' };
const INFO_CODEX = { larkAppId: 'cli_codex_1', botName: 'Codex' };

describe('resolveBotRefs', () => {
  it('resolves a single bot by botName', () => {
    const r = resolveBotRefs(['Claude'], [CFG_CLAUDE, CFG_CODEX], [INFO_CLAUDE, INFO_CODEX]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual([]);
    expect(r.ambiguousWarnings).toEqual([]);
  });

  it('resolves botName case-insensitively', () => {
    const r = resolveBotRefs(['claude', 'CODEX'], [CFG_CLAUDE, CFG_CODEX], [INFO_CLAUDE, INFO_CODEX]);
    expect(r.larkAppIds).toEqual(['cli_claude_1', 'cli_codex_1']);
  });

  it('resolves multiple bots preserving input order', () => {
    const r = resolveBotRefs(['CoCo', 'Claude'], [CFG_COCO_1, CFG_CLAUDE], [INFO_COCO_1, INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_coco_1', 'cli_claude_1']);
  });

  it('resolves by exact larkAppId', () => {
    const r = resolveBotRefs(['cli_coco_2'], [CFG_COCO_1, CFG_COCO_2], [INFO_COCO_1, INFO_COCO_2]);
    expect(r.larkAppIds).toEqual(['cli_coco_2']);
  });

  it('falls back to cliId when botName is unknown', () => {
    const r = resolveBotRefs(['codex'], [CFG_CODEX], []);
    expect(r.larkAppIds).toEqual(['cli_codex_1']);
  });

  it('picks first match in bots.json order when botName is ambiguous + emits warning', () => {
    const r = resolveBotRefs(
      ['CoCo'],
      [CFG_COCO_1, CFG_COCO_2],
      [INFO_COCO_1, INFO_COCO_2],
    );
    expect(r.larkAppIds).toEqual(['cli_coco_1']);
    expect(r.ambiguousWarnings).toHaveLength(1);
    expect(r.ambiguousWarnings[0]).toContain('CoCo');
    expect(r.ambiguousWarnings[0]).toContain('cli_coco_1');
  });

  it('honors botConfigs order even when bots-info.json order is reversed', () => {
    // Regression for Codex blocker: bots-info.json is merge-written by multiple
    // daemons, so its entry order is NOT bots.json order. The resolver MUST
    // walk botConfigs (= bots.json deployment order) when picking among
    // name-matched entries, not the bots-info iteration order.
    const r = resolveBotRefs(
      ['CoCo'],
      [CFG_COCO_1, CFG_COCO_2],           // bots.json order: 1, 2
      [INFO_COCO_2, INFO_COCO_1],         // bots-info.json order: 2, 1 (reversed)
    );
    expect(r.larkAppIds).toEqual(['cli_coco_1']);  // still picks bots.json[0]
    expect(r.ambiguousWarnings[0]).toContain('cli_coco_1');
  });

  it('dedups duplicate refs preserving first occurrence', () => {
    const r = resolveBotRefs(
      ['Claude', 'CoCo', 'claude', 'cli_coco_1'],
      [CFG_CLAUDE, CFG_COCO_1],
      [INFO_CLAUDE, INFO_COCO_1],
    );
    expect(r.larkAppIds).toEqual(['cli_claude_1', 'cli_coco_1']);
  });

  it('reports unresolvable refs in `invalid`', () => {
    const r = resolveBotRefs(
      ['Claude', 'NotABot'],
      [CFG_CLAUDE],
      [INFO_CLAUDE],
    );
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual(['NotABot']);
  });

  it('returns empty larkAppIds when no ref resolves', () => {
    const r = resolveBotRefs(['Ghost'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual([]);
    expect(r.invalid).toEqual(['Ghost']);
  });

  it('ignores empty/whitespace refs', () => {
    const r = resolveBotRefs(['', '  ', 'Claude'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.invalid).toEqual([]);
  });

  it('prefers larkAppId over name even when both could match', () => {
    // If a bot's larkAppId happens to also be a name (silly case), exact appId wins
    const r = resolveBotRefs(['cli_claude_1'], [CFG_CLAUDE], [INFO_CLAUDE]);
    expect(r.larkAppIds).toEqual(['cli_claude_1']);
    expect(r.ambiguousWarnings).toEqual([]);
  });
});

describe('resolveKickoff', () => {
  const selected = ['cli_creator', 'cli_reviewer'];
  const botInfo = [
    { larkAppId: 'cli_creator', botOpenId: 'ou_creator_self' },
    { larkAppId: 'cli_reviewer', botOpenId: 'ou_reviewer_self' },
    { larkAppId: 'cli_unselected', botOpenId: 'ou_unselected_self' },
  ];

  it('accepts an omitted kickoff pair', () => {
    expect(resolveKickoff(undefined, undefined, selected, botInfo)).toEqual({ ok: true });
  });

  it('requires both kickoff arguments and rejects whitespace-only values', () => {
    expect(resolveKickoff('ou_reviewer_self', undefined, selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 与 --kickoff-prompt 必须同时提供且不能为空。',
    });
    expect(resolveKickoff('   ', 'review this', selected, botInfo).ok).toBe(false);
  });

  it('resolves a selected non-creator bot and trims the prompt', () => {
    expect(resolveKickoff(' ou_reviewer_self ', ' review this ', selected, botInfo)).toEqual({
      ok: true,
      targetLarkAppId: 'cli_reviewer',
      prompt: 'review this',
    });
  });

  it('rejects an unknown or unselected bot open_id', () => {
    expect(resolveKickoff('ou_unknown', 'review', selected, botInfo).ok).toBe(false);
    expect(resolveKickoff('ou_unselected_self', 'review', selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 必须属于本次 --bot 列表。',
    });
  });

  it('rejects the creator bot', () => {
    expect(resolveKickoff('ou_creator_self', 'review', selected, botInfo)).toEqual({
      ok: false,
      error: '--kickoff-bot 不能是 creator（第一个 --bot）。',
    });
  });
});
