import { describe, expect, it } from 'vitest';
import {
  A2A_CAPABILITY_DELIVERY_V1,
  A2A_CAPABILITY_DISPATCH_REPO_V1,
  evaluateDispatchReadiness,
  resolveDispatchMentionIdentities,
} from '../src/core/a2a-readiness.js';
import { buildDispatchMessages } from '../src/core/dispatch.js';

const localWorker = {
  openId: 'ou_local',
  name: 'traex-loopy',
  larkAppId: 'cli_local',
  cliId: 'traex',
  local: true,
};

const remoteWorker = {
  openId: 'ou_remote',
  name: 'relay-loopy(d2)',
  larkAppId: 'cli_remote',
  cliId: 'relay',
  unionId: 'on_remote',
  local: false,
};

describe('evaluateDispatchReadiness', () => {
  it('accepts local and compatible remote workers that are in the target chat', () => {
    const result = evaluateDispatchReadiness({
      workers: [localWorker, remoteWorker],
      membership: {
        known: true,
        members: [
          { openId: 'ou_local', name: 'traex-loopy' },
          { openId: 'ou_remote', name: 'relay-loopy(d2)' },
        ],
      },
      peers: [{
        larkAppId: 'cli_remote',
        unionId: 'on_remote',
        name: 'relay-loopy(d2)',
        a2aCapabilities: [A2A_CAPABILITY_DELIVERY_V1, A2A_CAPABILITY_DISPATCH_REPO_V1],
      }],
      requiredCapabilities: [A2A_CAPABILITY_DELIVERY_V1, A2A_CAPABILITY_DISPATCH_REPO_V1],
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('hard-fails a known missing chat member', () => {
    const result = evaluateDispatchReadiness({
      workers: [remoteWorker],
      membership: { known: true, members: [] },
      peers: [],
      requiredCapabilities: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'worker_not_in_chat',
      workerName: 'relay-loopy(d2)',
    }));
  });

  it('does not block when the membership API is temporarily unavailable', () => {
    const result = evaluateDispatchReadiness({
      workers: [localWorker],
      membership: { known: false, members: [], reason: 'timeout' },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([expect.objectContaining({
      severity: 'warning',
      code: 'membership_unavailable',
    })]);
  });

  it('matches membership by the unique peer display name when open_id differs by app scope', () => {
    const result = evaluateDispatchReadiness({
      workers: [{ ...remoteWorker, openId: 'cli_remote', name: 'cli_remote' }],
      membership: { known: true, members: [{ openId: 'ou_receiver_scoped', name: 'relay-loopy(d2)' }] },
      peers: [{ larkAppId: 'cli_remote', name: 'relay-loopy(d2)' }],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('resolves an app_id into the observer-scoped mention handle used on the wire', () => {
    const resolution = resolveDispatchMentionIdentities({
      workers: [{ ...remoteWorker, openId: 'cli_remote', name: 'cli_remote' }],
      membership: { known: true, members: [{ openId: 'ou_receiver_scoped', name: 'relay-loopy(d2)' }] },
      peers: [{ larkAppId: 'cli_remote', name: 'relay-loopy(d2)' }],
    });
    expect(resolution.issues).toEqual([]);
    expect(resolution.workers[0]!.openId).toBe('ou_receiver_scoped');

    const message = buildDispatchMessages({
      title: 'Remote task',
      brief: 'Run checks.',
      bots: [{ openId: resolution.workers[0]!.openId, name: 'relay-loopy(d2)' }],
    });
    expect(message.kickoffText).toContain('<at user_id="ou_receiver_scoped"></at>');
    expect(message.kickoffText).not.toContain('cli_remote');
  });

  it('hard-fails when only an app_id is known and membership cannot be read', () => {
    const result = evaluateDispatchReadiness({
      workers: [{ ...remoteWorker, openId: 'cli_remote' }],
      membership: { known: false, members: [], reason: 'timeout' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'mention_identity_unavailable',
      severity: 'error',
    }));
  });

  it('hard-fails ambiguous display-name matches instead of mentioning an arbitrary bot', () => {
    const result = evaluateDispatchReadiness({
      workers: [{ ...remoteWorker, openId: 'cli_remote' }],
      membership: {
        known: true,
        members: [
          { openId: 'ou_remote_a', name: 'relay-loopy(d2)' },
          { openId: 'ou_remote_b', name: 'relay-loopy(d2)' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'mention_identity_ambiguous' }));
  });

  it('rejects a frozen release when the current group resolves a different open_id', () => {
    const result = evaluateDispatchReadiness({
      workers: [{ ...remoteWorker, openId: 'ou_stale_scope' }],
      membership: { known: true, members: [{ openId: 'ou_current_scope', name: 'relay-loopy(d2)' }] },
      requireExactMentionOpenIds: true,
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'mention_identity_mismatch' }));
  });

  it('warns for a remote worker whose capabilities are not yet advertised', () => {
    const result = evaluateDispatchReadiness({
      workers: [remoteWorker],
      membership: { known: true, members: [{ openId: 'ou_remote', name: 'relay-loopy(d2)' }] },
      peers: [{ larkAppId: 'cli_remote', name: 'relay-loopy(d2)', botmuxVersion: '2.108.0' }],
      requiredCapabilities: [A2A_CAPABILITY_DELIVERY_V1],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'capability_unknown',
    }));
  });

  it('hard-fails a remote worker that explicitly lacks a required capability', () => {
    const result = evaluateDispatchReadiness({
      workers: [remoteWorker],
      membership: { known: true, members: [{ openId: 'ou_remote', name: 'relay-loopy(d2)' }] },
      peers: [{
        larkAppId: 'cli_remote',
        name: 'relay-loopy(d2)',
        botmuxVersion: '2.108.0',
        a2aCapabilities: [A2A_CAPABILITY_DELIVERY_V1],
      }],
      requiredCapabilities: [A2A_CAPABILITY_DELIVERY_V1, A2A_CAPABILITY_DISPATCH_REPO_V1],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'capability_incompatible',
      detail: expect.stringContaining(A2A_CAPABILITY_DISPATCH_REPO_V1),
    }));
  });

  it('distinguishes an explicit empty capability set from an unknown legacy peer', () => {
    const result = evaluateDispatchReadiness({
      workers: [remoteWorker],
      membership: { known: true, members: [{ openId: 'ou_remote', name: 'relay-loopy(d2)' }] },
      peers: [{
        larkAppId: 'cli_remote',
        name: 'relay-loopy(d2)',
        a2aCapabilities: [],
      }],
      requiredCapabilities: [A2A_CAPABILITY_DELIVERY_V1],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'capability_incompatible',
    }));
  });

  it('merges capability facts for the same peer across platform and federation sources', () => {
    const result = evaluateDispatchReadiness({
      workers: [remoteWorker],
      membership: { known: true, members: [{ openId: 'ou_remote', name: 'relay-loopy(d2)' }] },
      peers: [
        {
          larkAppId: 'cli_remote',
          name: 'relay-loopy(d2)',
          botmuxVersion: '2.109.0',
        },
        {
          larkAppId: 'cli_remote',
          unionId: 'on_remote',
          name: 'relay-loopy(d2)',
          a2aCapabilities: [A2A_CAPABILITY_DELIVERY_V1, A2A_CAPABILITY_DISPATCH_REPO_V1],
        },
      ],
      requiredCapabilities: [A2A_CAPABILITY_DELIVERY_V1, A2A_CAPABILITY_DISPATCH_REPO_V1],
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });
});
