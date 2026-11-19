/**
 * `botmux workflow status|edit` argument handling and daemon-response
 * mapping, and the confirmation card's interactive shape.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatV3RunEditResponse,
  parseV3RunEditCliOptions,
  readV3RunEditPatch,
} from '../src/cli/v3-run-edit.js';
import {
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_REJECT_ACTION,
  buildV3RevisionCard,
  v3RevisionCardNonce,
} from '../src/im/lark/v3-revision-card.js';
import type { V3RevisionCardView } from '../src/workflows/v3/run-edit.js';
import { materialize } from '../src/workflows/v3/state.js';
import type { StoredEvent } from '../src/workflows/v3/event-contract.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('workflow edit options', () => {
  it('needs a patch source and a positive base revision; rejects unknown flags', () => {
    expect(parseV3RunEditCliOptions(['--patch-file', 'p.json', '--base', '3'])).toEqual({ ok: true, patchFile: 'p.json', base: 3, json: false });
    expect(parseV3RunEditCliOptions(['--patch-file', '-', '--base', '1', '--json'])).toMatchObject({ ok: true, patchFile: '-', json: true });
    for (const bad of [
      ['--base', '1'],
      ['--patch-file', 'p.json'],
      ['--patch-file', 'p.json', '--base', '0'],
      ['--patch-file', 'p.json', '--base', 'two'],
      ['--patch-file', 'p.json', '--base', '1', '--force'],
    ]) {
      expect(parseV3RunEditCliOptions(bad).ok).toBe(false);
    }
  });

  it('reads the patch from a file or stdin and refuses non-JSON / oversized patches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-edit-cli-'));
    dirs.push(dir);
    const file = join(dir, 'p.json');
    writeFileSync(file, '{"ops":[{"op":"rerunNode","nodeId":"a"}]}');
    expect(readV3RunEditPatch(file)).toEqual({ ops: [{ op: 'rerunNode', nodeId: 'a' }] });
    expect(readV3RunEditPatch('-', () => '[{"op":"removeNode","nodeId":"b"}]')).toHaveLength(1);
    expect(() => readV3RunEditPatch('-', () => '{not json')).toThrow();
    expect(() => readV3RunEditPatch('-', () => JSON.stringify({ ops: [{ op: 'x', blob: 'y'.repeat(20_000) }] }))).toThrow();
  });
});

describe('workflow edit responses', () => {
  const respond = (status: number, body: unknown) =>
    formatV3RunEditResponse('r1', { ok: status < 300, status, bodyRaw: JSON.stringify(body) });

  it('applied and proposed succeed; conflict, invalid and refusals fail with distinct exit codes', () => {
    expect(respond(200, { ok: true, kind: 'applied', revision: 2, summary: '+1 节点' }).exitCode).toBe(0);
    expect(respond(202, { ok: true, kind: 'proposed', revision: 3, reasons: ['newBot'], cardPosted: true }).exitCode).toBe(0);
    const conflict = respond(409, { ok: false, error: 'revision_conflict', currentRevision: 4 });
    const invalid = respond(422, { ok: false, error: 'invalid_edit', problems: ['p1'] });
    const refused = respond(409, { ok: false, error: 'run_not_editable' });
    expect(new Set([conflict.exitCode, invalid.exitCode, refused.exitCode]).size).toBe(3);
    expect(conflict.exitCode).not.toBe(0);
    expect(invalid.text).toContain('p1');
  });

  it('an applied edit names every pending change it voided and every one it carried onto a new version', () => {
    const mentions = (line: string, revision: number) => new RegExp(`(^|\\D)${revision}(\\D|$)`).test(line);
    const plain = respond(200, { ok: true, kind: 'applied', revision: 5, summary: '改 1 节点' }).text.split('\n');
    const out = respond(200, {
      ok: true, kind: 'applied', revision: 5, summary: '改 1 节点',
      voidedProposals: [{ revision: 3, reason: 'stale' }], carriedProposals: [{ from: 4, revision: 6 }],
    });
    expect(out.exitCode).toBe(0);
    const extra = out.text.split('\n').slice(plain.length);
    expect(extra).toHaveLength(2);
    expect(extra.filter((line) => mentions(line, 3))).toHaveLength(1);
    expect(extra.filter((line) => mentions(line, 4) && mentions(line, 6))).toHaveLength(1);
  });

  it('says why each pending change was voided, and where each card ended up', () => {
    const lineFor = (body: Record<string, unknown>) => respond(200, { ok: true, kind: 'applied', revision: 5, summary: 's', ...body })
      .text.split('\n')[1]!;
    const voided = (cause: string | undefined, card = 'frozen') => lineFor({ voidedProposals: [{ revision: 3, reason: 'stale', ...(cause ? { cause } : {}), card }] });
    const causes = ['overlap', 'notApplicable', 'meaningChanged', 'carryFailed', undefined].map((cause) => voided(cause));
    expect(new Set(causes).size).toBe(causes.length);
    expect(voided('overlap', 'none')).not.toBe(voided('overlap', 'frozen'));
    const carried = (card: string) => lineFor({ carriedProposals: [{ from: 4, revision: 6, card }] });
    expect(new Set(['moved', 'posted', 'failed'].map(carried)).size).toBe(3);
  });
});

describe('confirmation card', () => {
  const view: V3RevisionCardView = {
    revision: 3,
    baseRevision: 2,
    summary: '+1 节点、改派 1',
    note: '<at id=all></at> please',
    reasons: ['newBot', 'callerNotInitiator'],
    changes: {
      added: ['c'], removed: [], changed: [], dependsChanged: [], reassigned: [{ nodeId: 'a', to: 'cli_x' }],
      rerun: [], newBots: ['cli_x'], hostNodes: [], gateChanges: [],
    },
    proposedBy: 'ou_other',
  };
  type Card = { elements: Array<{ tag: string; text?: { tag: string }; actions?: Array<{ value?: { action?: string; nonce?: string } }> }> };
  const buttons = (card: Card) => card.elements.flatMap((element) => element.actions ?? []).filter((action) => action.value);

  it('offers approve / reject with a stable nonce while pending, and nothing once decided', () => {
    const pending = JSON.parse(buildV3RevisionCard({ runId: 'r1', view, webDetailUrl: 'https://x' })) as Card;
    expect(buttons(pending).map((action) => action.value!.action)).toEqual([V3_REVISION_APPROVE_ACTION, V3_REVISION_REJECT_ACTION]);
    expect(buttons(pending).every((action) => action.value!.nonce === v3RevisionCardNonce('r1', 3))).toBe(true);
    for (const resolution of [{ kind: 'approved' }, { kind: 'rejected' }, { kind: 'void' }] as const) {
      const frozen = JSON.parse(buildV3RevisionCard({ runId: 'r1', view, webDetailUrl: 'https://x', resolution })) as Card;
      expect(buttons(frozen)).toEqual([]);
    }
  });

  it('shows the proposer as a role, never as a raw open_id', () => {
    const proposerOf = (proposed: Partial<V3RevisionCardView>): string => {
      const card = JSON.parse(buildV3RevisionCard({ runId: 'r1', view: { ...view, ...proposed }, webDetailUrl: 'https://x' })) as {
        elements: Array<{ fields?: Array<{ text: { content: string } }> }>;
      };
      return card.elements.flatMap((element) => element.fields ?? []).map((field) => field.text.content).join('\n');
    };
    const member = proposerOf({});
    const initiator = proposerOf({ proposedBy: 'ou_initiator', reasons: ['hostNode'] });
    const mainBot = proposerOf({ proposedBy: 'main_bot', reasons: ['newBot'] });
    for (const shown of [member, initiator, mainBot]) expect(shown).not.toMatch(/ou_|main_bot/);
    // Three distinct roles, so the initiator can tell who asked.
    expect(new Set([member, initiator, mainBot]).size).toBe(3);
  });

  it('never renders free text as lark_md (no mention side effects)', () => {
    const card = JSON.parse(buildV3RevisionCard({ runId: 'r1', view, webDetailUrl: 'https://x' })) as Card;
    expect(card.elements.filter((element) => element.text).every((element) => element.text!.tag === 'plain_text')).toBe(true);
  });
});

describe('host instances a revision superseded', () => {
  it('a late host preparation cannot revive the superseded instance', () => {
    let ts = 0;
    const events = [
      { type: 'runStarted', runId: 'r' },
      { type: 'gateDispatched', nodeId: 'h', instanceId: 'h#001', waitId: 'h#001-host-001-gate' },
      {
        type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: '改 1 节点', by: 'ou',
        effects: { supersede: [{ nodeId: 'h', instanceId: 'h#001', waitId: 'h#001-host-001-gate' }] },
      },
      {
        type: 'hostInputPrepared', nodeId: 'h', instanceId: 'h#001', attemptId: 'h#001/attempts/001',
        executor: 'feishu-send', provider: 'p', inputRef: { path: 'x', sha256: 's', bytes: 1 },
        inputHash: 'i', idempotencyKey: 'k', idempotencyTtlMs: 1, approvalDigest: 'd',
      },
    ].map((event) => ({ ts: ++ts, ...event })) as StoredEvent[];
    const snap = materialize(events);
    expect(snap.nodes.get('h')).toEqual({ status: 'pending' });
    expect(snap.instances.get('h#001')?.status).toBe('superseded');
  });
});
