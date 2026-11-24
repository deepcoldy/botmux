import { describe, expect, it, vi } from 'vitest';
import {
  buildApprovalConsoleUrl,
  candidateScopeKey,
  classifySensitiveScopeGroup,
  deferredScopesToBuckets,
  mergeDeferredApprovalScopes,
  normalizeApprovalDeferredScopes,
  resolveAutoApprovedScopes,
  resolveNextPersistedApprovalDeferredScopes,
  type ApprovalCandidateScope,
} from '../src/setup/approval-scope-resolver.js';
import type { ApprovalFlowPrediction } from '../src/setup/open-platform-automation.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { applyBotConfigEdits, cloneBotConfig } from '../src/setup/bot-config-editor.js';
import { filterDeferredRequiredScopes } from '../src/im/lark/event-dispatcher.js';

interface DraftHarnessOptions {
  candidates: ApprovalCandidateScope[];
  blockingKeys: Iterable<string>;
  blockRefreshToken?: boolean;
  blockBaseline?: boolean;
  initialAllowRefreshToken?: boolean;
  approvers?: string[];
  onAdd?: (scopes: readonly ApprovalCandidateScope[]) => void;
  failOnRemoveCall?: number;
  loseResponseOnRemoveCall?: number;
  loseResponseOnSetRefreshTokenCall?: number;
}

/**
 * Stateful in-memory Feishu draft simulator. Tracks the exact set of staged
 * (bucket:id) scopes and `allowRefreshToken`, and computes `probeApproval()`
 * purely from the current live draft state (just like Feishu's console).
 */
function createDraftHarness(opts: DraftHarnessOptions) {
  const staged = new Set(opts.candidates.map(c => candidateScopeKey(c)));
  const blocking = new Set(opts.blockingKeys);
  const approvers = opts.approvers ?? ['企业管理员'];
  let allowRefreshToken = opts.initialAllowRefreshToken ?? false;
  let removeCalls = 0;
  let addCalls = 0;
  let probeCalls = 0;
  let setRefreshTokenCalls = 0;
  const onScopesAddedCalls: ApprovalCandidateScope[][] = [];

  const predict = (): ApprovalFlowPrediction => {
    if (opts.blockBaseline) {
      return { known: true, autoApproved: false, humanApprovers: approvers };
    }
    if (opts.blockRefreshToken && allowRefreshToken) {
      return { known: true, autoApproved: false, humanApprovers: approvers };
    }
    for (const key of staged) {
      if (blocking.has(key)) {
        return { known: true, autoApproved: false, humanApprovers: approvers };
      }
    }
    return { known: true, autoApproved: true, humanApprovers: [] };
  };

  return {
    staged,
    get allowRefreshToken() { return allowRefreshToken; },
    get removeCalls() { return removeCalls; },
    get addCalls() { return addCalls; },
    get probeCalls() { return probeCalls; },
    onScopesAddedCalls,
    initialPrediction: predict(),
    removeScopes: async (scopes: readonly ApprovalCandidateScope[]) => {
      removeCalls += 1;
      if (opts.failOnRemoveCall !== undefined && removeCalls === opts.failOnRemoveCall) {
        throw new Error('simulated scope/update del failure');
      }
      for (const s of scopes) staged.delete(candidateScopeKey(s));
      if (opts.loseResponseOnRemoveCall !== undefined && removeCalls === opts.loseResponseOnRemoveCall) {
        throw new Error('simulated response loss after scope/update del was applied');
      }
    },
    addScopes: async (scopes: readonly ApprovalCandidateScope[]) => {
      addCalls += 1;
      for (const s of scopes) staged.add(candidateScopeKey(s));
      opts.onAdd?.(scopes);
    },
    onScopesAdded: async (scopes: readonly ApprovalCandidateScope[]) => {
      onScopesAddedCalls.push([...scopes]);
    },
    setAllowRefreshToken: async (enabled: boolean) => {
      setRefreshTokenCalls += 1;
      allowRefreshToken = enabled;
      if (setRefreshTokenCalls === opts.loseResponseOnSetRefreshTokenCall) {
        throw new Error('simulated response loss after safe_setting/update was applied');
      }
    },
    probeApproval: async (): Promise<ApprovalFlowPrediction> => {
      probeCalls += 1;
      return predict();
    },
  };
}

function makeTemplateLikeCandidates(): ApprovalCandidateScope[] {
  return [
    { bucket: 'tenant', name: 'im:message', id: '1', level: 3 },
    { bucket: 'tenant', name: 'im:chat:readonly', id: '2', level: 3 },
    { bucket: 'user', name: 'im:message:readonly', id: '3', level: 3 },
    // 8 level-4 scopes mirroring developer_console 1.0.0 template
    { bucket: 'tenant', name: 'application:bot.basic_info:read', id: '10', level: 4 },
    { bucket: 'tenant', name: 'contact:contact.base:readonly', id: '11', level: 4 },
    { bucket: 'tenant', name: 'docs:document.comment:create', id: '12', level: 4 },
    { bucket: 'tenant', name: 'docs:document.comment:delete', id: '13', level: 4 },
    { bucket: 'tenant', name: 'docs:document.comment:update', id: '14', level: 4 },
    { bucket: 'tenant', name: 'docx:document.block:convert', id: '15', level: 4 },
    { bucket: 'tenant', name: 'docx:document:write_only', id: '16', level: 4 },
    { bucket: 'user', name: 'offline_access', id: '17', level: 4 },
  ];
}

function makeLargeManifestCandidates(): ApprovalCandidateScope[] {
  const scopes: ApprovalCandidateScope[] = [];
  let seq = 1;
  const push = (bucket: 'tenant' | 'user', name: string, level: number) => {
    scopes.push({ bucket, name, id: String(seq++), level });
  };
  // Level-3 baseline scopes
  for (let i = 0; i < 10; i++) push('tenant', `im:base_lv3_${i}`, 3);
  // Group 0: core_im
  push('tenant', 'im:message.group_msg', 4);
  push('tenant', 'contact:user.base:readonly', 4);
  // Group 1: offline_access
  push('user', 'offline_access', 4);
  // Group 2: im_extra
  for (let i = 0; i < 16; i++) push('tenant', `im:extra_${i}`, 4);
  // Group 3: contact_search
  for (let i = 0; i < 16; i++) push('tenant', `contact:extra_${i}`, 4);
  // Group 4: docs_drive
  for (let i = 0; i < 20; i++) push('tenant', `docs:extra_${i}`, 4);
  // Group 5: base
  for (let i = 0; i < 16; i++) push('tenant', `bitable:extra_${i}`, 4);
  // Group 6: calendar
  for (let i = 0; i < 16; i++) push('tenant', `calendar:extra_${i}`, 4);
  // Group 7: wiki_slides_board
  for (let i = 0; i < 16; i++) push('tenant', `wiki:extra_${i}`, 4);
  // Group 8: vc_task
  for (let i = 0; i < 12; i++) push('tenant', `vc:extra_${i}`, 4);
  for (let i = 0; i < 8; i++) push('tenant', `task:extra_${i}`, 4);
  return scopes;
}

describe('resolveAutoApprovedScopes', () => {
  it('takes zero mutations and zero probes when initial prediction is already auto-approved', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({ candidates, blockingKeys: [] });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome).toEqual({
      triggered: false,
      resolvedAutoApproved: true,
      deferredScopes: [],
      disabledRefreshToken: false,
      initialHumanApprovers: [],
      remainingHumanApprovers: [],
      probeCount: 0,
      stopReason: 'already_auto_approved',
    });
    expect(h.removeCalls).toBe(0);
    expect(h.addCalls).toBe(0);
    expect(h.probeCalls).toBe(0);
    expect(h.staged.size).toBe(candidates.length);
  });

  it('takes zero mutations when approval prediction is unknown/unavailable', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({ candidates, blockingKeys: ['user:17'] });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: { known: false, autoApproved: false, humanApprovers: [] },
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.triggered).toBe(false);
    expect(outcome.stopReason).toBe('probe_unavailable');
    expect(h.removeCalls).toBe(0);
    expect(h.probeCalls).toBe(0);
  });

  it('isolates a single blocking scope in a small template set via exact binary search', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:17'], // user:offline_access
      approvers: ['张管理员'],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('resolved_exact');
    expect(outcome.initialHumanApprovers).toEqual(['张管理员']);
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'user', name: 'offline_access', isolation: 'exact' }),
    ]);
    // Final draft has all non-blocking scopes (including the other 7 level-4 scopes) and passes approval
    expect(h.staged.has('user:17')).toBe(false);
    expect(h.staged.size).toBe(candidates.length - 1);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('isolates multiple blocking scopes in a small set and keeps all non-blocking level-4 scopes', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['tenant:11', 'user:17'],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('resolved_exact');
    expect(outcome.deferredScopes.map(s => `${s.bucket}:${s.name}`).sort()).toEqual([
      'tenant:contact:contact.base:readonly',
      'user:offline_access',
    ]);
    expect(h.staged.size).toBe(candidates.length - 2);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('isolates a single blocking scope inside a 140+ large manifest within probe budget', async () => {
    const candidates = makeLargeManifestCandidates();
    const target = candidates.find(c => c.name === 'docs:extra_11')!;
    const h = createDraftHarness({
      candidates,
      blockingKeys: [candidateScopeKey(target)],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      maxProbes: 14,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      onScopesAdded: h.onScopesAdded,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('resolved_exact');
    expect(outcome.probeCount).toBeLessThanOrEqual(14);
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'tenant', name: 'docs:extra_11', isolation: 'exact', group: 'docs_drive' }),
    ]);
    expect(h.staged.size).toBe(candidates.length - 1);
    expect(h.staged.has(candidateScopeKey(target))).toBe(false);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('does NOT false-trigger the all-level-4 circuit breaker when only the first group (G0 core_im) has a bad scope', async () => {
    const candidates = makeLargeManifestCandidates();
    const target = candidates.find(c => c.name === 'im:message.group_msg')!;
    const h = createDraftHarness({
      candidates,
      blockingKeys: [candidateScopeKey(target)],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      maxProbes: 14,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('resolved_exact');
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'tenant', name: 'im:message.group_msg', isolation: 'exact', group: 'core_im' }),
    ]);
    // All other groups and contact:user.base:readonly MUST remain staged!
    expect(h.staged.size).toBe(candidates.length - 1);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('circuit-breaks to level-3 only when all level-4 groups require approval', async () => {
    const candidates = makeLargeManifestCandidates();
    const allLevel4 = candidates.filter(c => c.level === 4);
    const h = createDraftHarness({
      candidates,
      blockingKeys: allLevel4.map(candidateScopeKey),
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      maxProbes: 14,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('resolved_level3_only');
    expect(outcome.deferredScopes).toHaveLength(allLevel4.length);
    expect(outcome.deferredScopes.every(s => s.isolation === 'all_level4')).toBe(true);
    // All level-3 scopes remain staged and the draft is auto-approved
    expect(h.staged.size).toBe(candidates.length - allLevel4.length);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('keeps all scopes when disabling allowRefreshToken alone resolves approval', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: [],
      blockRefreshToken: true,
      initialAllowRefreshToken: true,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: h.setAllowRefreshToken,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.disabledRefreshToken).toBe(true);
    expect(outcome.deferredScopes).toEqual([]);
    expect(h.allowRefreshToken).toBe(false);
    expect(h.staged.size).toBe(candidates.length);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('handles both allowRefreshToken and a blocking sensitive scope together', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:17'],
      blockRefreshToken: true,
      initialAllowRefreshToken: true,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: h.setAllowRefreshToken,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.disabledRefreshToken).toBe(true);
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'user', name: 'offline_access', isolation: 'exact' }),
    ]);
    expect(h.allowRefreshToken).toBe(false);
    expect(h.staged.size).toBe(candidates.length - 1);
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('restores original draft and allowRefreshToken when even level-3 baseline requires approval', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: [],
      blockBaseline: true,
      initialAllowRefreshToken: true,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: h.setAllowRefreshToken,
      probeApproval: h.probeApproval,
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.resolvedAutoApproved).toBe(false);
    expect(outcome.stopReason).toBe('baseline_requires_approval');
    expect(outcome.deferredScopes).toEqual([]);
    expect(outcome.disabledRefreshToken).toBe(false);
    // Original full draft and refresh-token setting must be restored
    expect(h.staged.size).toBe(candidates.length);
    expect(h.allowRefreshToken).toBe(true);
  });

  it('keeps tenant and user buckets independent when the same scope name/id appears in both', async () => {
    const candidates: ApprovalCandidateScope[] = [
      { bucket: 'tenant', name: 'im:resource', id: '99', level: 3 },
      { bucket: 'user', name: 'im:resource', id: '99', level: 4 },
      { bucket: 'tenant', name: 'im:message.group_msg', id: '100', level: 4 },
    ];
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:99'],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'user', name: 'im:resource', isolation: 'exact' }),
    ]);
    expect(h.staged.has('tenant:99')).toBe(true);
    expect(h.staged.has('tenant:100')).toBe(true);
    expect(h.staged.has('user:99')).toBe(false);
  });

  it('invokes onScopesAdded when re-adding vc/task scopes during probing', async () => {
    const candidates = makeLargeManifestCandidates();
    const target = candidates.find(c => c.name === 'vc:extra_3')!;
    const h = createDraftHarness({
      candidates,
      blockingKeys: [candidateScopeKey(target)],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      maxProbes: 14,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      onScopesAdded: h.onScopesAdded,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.deferredScopes.map(s => s.name)).toEqual(['vc:extra_3']);
    expect(h.onScopesAddedCalls.some(batch => batch.some(s => s.name.startsWith('vc:')))).toBe(true);
  });

  it('falls back to group deferral when probe budget runs out and keeps final draft witnessed auto-approved', async () => {
    const candidates = makeLargeManifestCandidates();
    const target = candidates.find(c => c.name === 'docs:extra_7')!;
    const h = createDraftHarness({
      candidates,
      blockingKeys: [candidateScopeKey(target)],
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      maxProbes: 4,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.probeCount).toBeLessThanOrEqual(4);
    expect(['resolved_with_group_fallback', 'budget_exhausted']).toContain(outcome.stopReason);
    expect(outcome.deferredScopes.some(s => s.name === 'docs:extra_7')).toBe(true);
    // Final draft MUST be safe and auto-approved
    expect((await h.probeApproval()).autoApproved).toBe(true);
  });

  it('attempts best-effort restore and reports mutation_failed when scope/update throws', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:17'],
      failOnRemoveCall: 2,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.resolvedAutoApproved).toBe(false);
    expect(outcome.stopReason).toBe('mutation_failed');
    expect(outcome.restored).toBe(true);
    expect(h.staged.size).toBe(candidates.length);
  });

  it('re-adds the full original draft when a successful scope deletion loses its response', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:17'],
      loseResponseOnRemoveCall: 1,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      probeApproval: h.probeApproval,
    });

    expect(outcome.stopReason).toBe('mutation_failed');
    expect(outcome.restored).toBe(true);
    expect(h.staged).toEqual(new Set(candidates.map(candidateScopeKey)));
  });

  it('restores the original refresh-token setting when a successful toggle loses its response', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: [],
      blockRefreshToken: true,
      initialAllowRefreshToken: true,
      loseResponseOnSetRefreshTokenCall: 1,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: h.setAllowRefreshToken,
      probeApproval: h.probeApproval,
    });

    expect(outcome.stopReason).toBe('mutation_failed');
    expect(outcome.restored).toBe(true);
    expect(h.allowRefreshToken).toBe(true);
    expect(h.staged).toEqual(new Set(candidates.map(candidateScopeKey)));
  });

  it('reports restored=false and still restores scopes when setAllowRefreshToken(true) fails during restore', async () => {
    const candidates = makeTemplateLikeCandidates();
    const h = createDraftHarness({
      candidates,
      blockingKeys: ['user:17'],
      blockRefreshToken: true,
      initialAllowRefreshToken: true,
      failOnRemoveCall: 2,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: async enabled => {
        if (enabled) throw new Error('simulated safe_setting restore 500');
        await h.setAllowRefreshToken(false);
      },
      probeApproval: h.probeApproval,
    });

    expect(outcome.stopReason).toBe('mutation_failed');
    expect(outcome.restored).toBe(false);
    // Even though refreshToken restore threw, scope restore must still execute independently!
    expect(h.staged.size).toBe(candidates.length);
  });

  it('marks untested sensitive scope as group + budget_exhausted (not exact) when budget runs out after disabling refreshToken', async () => {
    const candidates: ApprovalCandidateScope[] = [
      { bucket: 'tenant', name: 'im:message', id: '1', level: 3 },
      { bucket: 'tenant', name: 'im:message.group_msg', id: '2', level: 4 },
    ];
    // Only allowRefreshToken blocks; tenant:2 is actually innocent, but maxProbes=2 runs out before probing tenant:2!
    const h = createDraftHarness({
      candidates,
      blockingKeys: [],
      blockRefreshToken: true,
      initialAllowRefreshToken: true,
    });

    const outcome = await resolveAutoApprovedScopes({
      initialPrediction: h.initialPrediction,
      candidates,
      initialAllowRefreshToken: true,
      maxProbes: 2,
      removeScopes: h.removeScopes,
      addScopes: h.addScopes,
      setAllowRefreshToken: h.setAllowRefreshToken,
      probeApproval: h.probeApproval,
    });

    expect(outcome.resolvedAutoApproved).toBe(true);
    expect(outcome.stopReason).toBe('budget_exhausted');
    expect(outcome.deferredScopes).toEqual([
      expect.objectContaining({ bucket: 'tenant', name: 'im:message.group_msg', isolation: 'group' }),
    ]);
    expect([...h.staged]).toEqual(['tenant:1']);
  });
});

describe('approval deferred scope helpers & persistence boundaries', () => {
  it('normalizes, merges, and classifies deferred scopes cleanly', () => {
    expect(normalizeApprovalDeferredScopes(undefined)).toBeUndefined();
    expect(normalizeApprovalDeferredScopes({ tenant: [], user: ['  '] })).toBeUndefined();
    expect(normalizeApprovalDeferredScopes({
      tenant: ['im:message.group_msg', 'im:message.group_msg', ' contact:user.base:readonly '],
      user: ['offline_access'],
    })).toEqual({
      tenant: ['contact:user.base:readonly', 'im:message.group_msg'],
      user: ['offline_access'],
    });

    const merged = mergeDeferredApprovalScopes(
      [{ bucket: 'user', name: 'offline_access', isolation: 'exact', group: 'offline_access' }],
      [
        { bucket: 'user', name: 'offline_access', isolation: 'group', group: 'offline_access' },
        { bucket: 'tenant', name: 'im:message.group_msg', isolation: 'exact', group: 'core_im' },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(deferredScopesToBuckets(merged)).toEqual({
      tenant: ['im:message.group_msg'],
      user: ['offline_access'],
    });

    expect(classifySensitiveScopeGroup({ bucket: 'tenant', name: 'im:message.group_msg' })).toBe('core_im');
    expect(classifySensitiveScopeGroup({ bucket: 'user', name: 'offline_access' })).toBe('offline_access');
    expect(classifySensitiveScopeGroup({ bucket: 'tenant', name: 'vc:meeting:readonly' })).toBe('vc_task');
    expect(buildApprovalConsoleUrl('cli_abc', 'feishu')).toBe('https://open.feishu.cn/app/cli_abc/auth');
    expect(buildApprovalConsoleUrl('cli_abc', 'lark')).toBe('https://open.larksuite.com/app/cli_abc/auth');
  });

  it('parses approvalDeferredScopes in bot-registry and strips it during cloneBotConfig', () => {
    const parsed = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_a',
      larkAppSecret: 'sec_a',
      approvalDeferredScopes: {
        tenant: ['im:message.group_msg', 'im:message.group_msg'],
        user: ['offline_access'],
      },
    }]));
    expect(parsed[0]!.approvalDeferredScopes).toEqual({
      tenant: ['im:message.group_msg'],
      user: ['offline_access'],
    });

    const cloned = cloneBotConfig(parsed[0]!, {
      larkAppId: 'cli_b',
      larkAppSecret: 'sec_b',
      allowedUsers: ['owner@example.com'],
    });
    expect(cloned.approvalDeferredScopes).toBeUndefined();
  });

  it('filters deferred scopes from daemon startup self-heal without suppressing non-deferred scopes', () => {
    const res = filterDeferredRequiredScopes(
      [
        { name: 'im:message.group_msg', desc: '群消息' },
        { name: 'im:resource', desc: '资源' },
      ],
      [
        { name: 'offline_access', desc: '离线刷新' },
        { name: 'im:chat.announcement:read', desc: '群公告' },
      ],
      [
        { name: 'offline_access', desc: '离线刷新' },
        { name: 'im:chat.announcement:read', desc: '群公告' },
      ],
      {
        tenant: ['im:message.group_msg', 'im:resource', 'im:chat.announcement:read'],
        user: ['offline_access', 'im:message:readonly'],
      },
      {
        tenant: ['im:message.group_msg'],
        user: ['offline_access'],
      },
    );

    expect(res.missingCritical.map(s => s.name)).toEqual(['im:resource']);
    expect(res.missingOptional.map(s => s.name)).toEqual(['im:chat.announcement:read']);
    expect(res.wholeMissingOptional.map(s => s.name)).toEqual(['im:chat.announcement:read']);
    expect(res.skippedDeferred.map(s => s.name)).toEqual(['im:message.group_msg', 'offline_access']);
  });

  it('does NOT suppress a tenant-bucket missing scope when only the user bucket of the same scope is deferred', () => {
    const res = filterDeferredRequiredScopes(
      [{ name: 'im:resource', desc: '资源' }],
      [],
      [],
      { tenant: ['im:resource'], user: ['im:resource'] },
      { user: ['im:resource'] },
    );

    // tenant bucket is NOT deferred, so critical scope im:resource must remain missing!
    expect(res.missingCritical.map(s => s.name)).toEqual(['im:resource']);
    expect(res.skippedDeferred).toEqual([]);
  });

  it('clears approvalDeferredScopes when applyBotConfigEdits rebinds larkAppId, and preserves it on unrelated edits', () => {
    const base = {
      larkAppId: 'cli_old',
      larkAppSecret: 'sec_old',
      cliId: 'claude-code',
      approvalDeferredScopes: { tenant: ['im:message.group_msg'], user: ['offline_access'] },
    };
    const renamed = applyBotConfigEdits(base, { name: 'new-name' });
    expect(renamed.approvalDeferredScopes).toEqual(base.approvalDeferredScopes);

    const rebound = applyBotConfigEdits(base, { larkAppId: 'cli_new', larkAppSecret: 'sec_new' });
    expect(rebound.approvalDeferredScopes).toBeUndefined();

    // autoAvoidApproval toggle: default ON (omitted in bots.json), only explicit false persisted
    const disabled = applyBotConfigEdits(base, { autoAvoidApproval: 'false' });
    expect(disabled.autoAvoidApproval).toBe(false);
    const reenabled = applyBotConfigEdits(disabled, { autoAvoidApproval: 'true' });
    expect(reenabled.autoAvoidApproval).toBeUndefined();

    const parsed = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_on', larkAppSecret: 's1', autoAvoidApproval: true },
      { larkAppId: 'cli_off', larkAppSecret: 's2', autoAvoidApproval: false },
    ]));
    expect(parsed[0]!.autoAvoidApproval).toBeUndefined();
    expect(parsed[1]!.autoAvoidApproval).toBe(false);
  });

  it('resolveNextPersistedApprovalDeferredScopes only clears on clean verified passes and preserves on inconclusive/warning runs', () => {
    const existing = { tenant: ['im:message.group_msg'], user: ['offline_access'] };
    // Clean auto-approved with 0 deferred -> clear
    expect(resolveNextPersistedApprovalDeferredScopes(existing, { approvalAutoPassed: true }, [])).toEqual({
      action: 'clear',
    });
    // Clean publishSkipped with 0 deferred -> clear
    expect(resolveNextPersistedApprovalDeferredScopes(existing, { publishSkipped: true }, [])).toEqual({
      action: 'clear',
    });
    // Inconclusive (approval_nodes/get failed, approvalAutoPassed=undefined) -> keep
    expect(resolveNextPersistedApprovalDeferredScopes(existing, {}, [])).toEqual({ action: 'keep' });
    // Human review (approvalAutoPassed=false) -> keep
    expect(resolveNextPersistedApprovalDeferredScopes(existing, { approvalAutoPassed: false }, [])).toEqual({
      action: 'keep',
    });
    // Commit left draft (versionWarning) or pending review (versionPendingReview) -> keep
    expect(
      resolveNextPersistedApprovalDeferredScopes(existing, { approvalAutoPassed: true, versionWarning: 'draft' }, []),
    ).toEqual({ action: 'keep' });
    expect(
      resolveNextPersistedApprovalDeferredScopes(existing, { approvalAutoPassed: true, versionPendingReview: true }, []),
    ).toEqual({ action: 'keep' });
    // Skipped catalog scopes make the full target unverified -> never clear.
    expect(
      resolveNextPersistedApprovalDeferredScopes(existing, { approvalAutoPassed: true, skippedScopeCount: 1 }, []),
    ).toEqual({ action: 'keep' });
    // Commit outcome unknown/failed: even a resolved auto-pass prediction only unions discoveries.
    expect(
      resolveNextPersistedApprovalDeferredScopes(
        existing,
        { ok: false, approvalAutoPassed: true },
        [{ bucket: 'tenant', name: 'contact:user.base:readonly', isolation: 'exact', group: 'core_im' }],
      ),
    ).toEqual({
      action: 'set',
      buckets: {
        tenant: ['contact:user.base:readonly', 'im:message.group_msg'],
        user: ['offline_access'],
      },
    });
    // Non-clean run with newly discovered deferred scope -> union with existing
    expect(
      resolveNextPersistedApprovalDeferredScopes(
        existing,
        { versionWarning: 'draft' },
        [{ bucket: 'tenant', name: 'contact:user.base:readonly', isolation: 'exact', group: 'core_im' }],
      ),
    ).toEqual({
      action: 'set',
      buckets: {
        tenant: ['contact:user.base:readonly', 'im:message.group_msg'],
        user: ['offline_access'],
      },
    });
  });
});
