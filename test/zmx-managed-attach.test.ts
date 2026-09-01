import { describe, expect, it, vi } from 'bun:test';
import {
  attachFrozenManagedZmxSession,
  freezeManagedZmxAttachTarget,
} from '../src/cli/zmx-managed-attach.js';

describe('managed ZMX attach identity fence', () => {
  const name = 'bmx-abcdef12';
  const sessionId = 'abcdef12-1111-2222-3333-444444444444';

  it('freezes one compatible PID and revalidates it immediately before attach', () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ state: 'compatible', pid: 4242, clients: 0 })
      .mockReturnValueOnce({ state: 'compatible', pid: 4242, clients: 1 });
    const attach = vi.fn(() => ({ status: 0, error: undefined }));

    const frozen = freezeManagedZmxAttachTarget(name, sessionId, { probe });
    expect(frozen).toEqual({ ok: true, pid: 4242 });
    if (!frozen.ok) throw new Error('expected compatible probe');

    expect(attachFrozenManagedZmxSession(name, sessionId, frozen.pid, { probe, attach }))
      .toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenNthCalledWith(1, name, sessionId);
    expect(probe).toHaveBeenNthCalledWith(2, name, sessionId);
    expect(attach).toHaveBeenCalledWith(name);
  });

  it.each([
    {
      label: 'unknown ownership',
      probe: { state: 'unknown', reason: 'control plane unavailable' } as const,
    },
    {
      label: 'transport mismatch',
      probe: { state: 'incompatible', pid: 4242, clients: 0, reason: 'transport-label' } as const,
    },
    {
      label: 'full session mismatch',
      probe: { state: 'incompatible', pid: 4242, clients: 0, reason: 'session-label' } as const,
    },
  ])('fails closed before attach on $label', ({ probe: probeResult }) => {
    const probe = vi.fn(() => probeResult);
    const attach = vi.fn();

    expect(freezeManagedZmxAttachTarget(name, sessionId, { probe })).toMatchObject({ ok: false });
    expect(attach).not.toHaveBeenCalled();
  });

  it('fails closed when the same name resolves to a replacement PID before attach', () => {
    const probe = vi.fn(() => ({ state: 'compatible' as const, pid: 5252, clients: 0 }));
    const attach = vi.fn();

    expect(attachFrozenManagedZmxSession(name, sessionId, 4242, { probe, attach }))
      .toMatchObject({ ok: false });
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'missing target',
      probe: { state: 'missing' } as const,
    },
    {
      label: 'unknown target',
      probe: { state: 'unknown', reason: 'timed out' } as const,
    },
    {
      label: 'changed ownership labels',
      probe: { state: 'incompatible', pid: 4242, clients: 0, reason: 'session-label' } as const,
    },
  ])('fails closed when the final pre-attach probe sees a $label', ({ probe: probeResult }) => {
    const probe = vi.fn(() => probeResult);
    const attach = vi.fn();

    expect(attachFrozenManagedZmxSession(name, sessionId, 4242, { probe, attach }))
      .toMatchObject({ ok: false });
    expect(attach).not.toHaveBeenCalled();
  });
});
