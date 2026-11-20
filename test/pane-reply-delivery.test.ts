import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { paneReplyDeliveryFromProcessTree, procPaneProcessReader, type PaneProcessReader } from '../src/services/pane-reply-delivery.js';
import { REPLY_DELIVERY_ENV } from '../src/services/send-completion-hint.js';

/** A fake /proc: pid → { environ (undefined = unreadable), children }. */
function tree(nodes: Record<number, { env?: Record<string, string> | null; children?: number[] }>): PaneProcessReader {
  return {
    environ: pid => {
      const env = nodes[pid]?.env;
      if (!env) return undefined;
      return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
    },
    children: pid => nodes[pid]?.children ?? [],
  };
}

describe('paneReplyDeliveryFromProcessTree', () => {
  it('returns the snapshot a fresh spawn froze into the pane process', () => {
    expect(paneReplyDeliveryFromProcessTree(10, 'send', tree({ 10: { env: { PATH: '/bin', [REPLY_DELIVERY_ENV]: 'transcript' } } })))
      .toBe('transcript');
    expect(paneReplyDeliveryFromProcessTree(10, 'transcript', tree({ 10: { env: { [REPLY_DELIVERY_ENV]: 'send' } } })))
      .toBe('send');
  });

  it('finds the snapshot below a launcher that does not carry it (wrapperCli, pane shell)', () => {
    const reader = tree({
      10: { env: { PATH: '/bin' }, children: [11] },
      11: { env: { PATH: '/bin' }, children: [12] },
      12: { env: { [REPLY_DELIVERY_ENV]: 'transcript' } },
    });
    expect(paneReplyDeliveryFromProcessTree(10, 'send', reader)).toBe('transcript');
  });

  it('a readable pane without the snapshot was launched by an older botmux: use the legacy delivery', () => {
    const reader = tree({ 10: { env: { PATH: '/bin' }, children: [11] }, 11: { env: { HOME: '/root' } } });
    expect(paneReplyDeliveryFromProcessTree(10, 'send', reader)).toBe('send');
    expect(paneReplyDeliveryFromProcessTree(10, 'transcript', reader)).toBe('transcript');
  });

  it('no readable environment is no evidence: the caller keeps its own value', () => {
    expect(paneReplyDeliveryFromProcessTree(10, 'send', tree({ 10: { env: null, children: [11] }, 11: { env: null } })))
      .toBeUndefined();
    expect(paneReplyDeliveryFromProcessTree(null, 'send', tree({}))).toBeUndefined();
    expect(paneReplyDeliveryFromProcessTree(undefined, 'send', tree({}))).toBeUndefined();
  });

  it('an unknown snapshot value is treated as send, never as transcript', () => {
    expect(paneReplyDeliveryFromProcessTree(10, 'transcript', tree({ 10: { env: { [REPLY_DELIVERY_ENV]: 'bogus' } } })))
      .toBe('send');
  });

  it.skipIf(process.platform !== 'linux')('reads a real pane process environment through /proc', async () => {
    const withSnapshot = spawn('sleep', ['30'], { env: { ...process.env, [REPLY_DELIVERY_ENV]: 'transcript' }, stdio: 'ignore' });
    const legacy = spawn('sleep', ['30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: 'ignore' });
    try {
      // The spawn event can precede exec (bun): wait until the child's own
      // environment is visible instead of reading the parent's copy.
      const deadline = Date.now() + 5_000;
      let seen: string | undefined;
      while (Date.now() < deadline) {
        seen = paneReplyDeliveryFromProcessTree(withSnapshot.pid, 'send');
        if (seen === 'transcript') break;
        await new Promise(r => setTimeout(r, 20));
      }
      expect(seen).toBe('transcript');
      let legacySeen: string | undefined;
      const legacyDeadline = Date.now() + 5_000;
      while (Date.now() < legacyDeadline) {
        const environ = procPaneProcessReader.environ(legacy.pid!);
        if (environ !== undefined && !environ.includes(`${REPLY_DELIVERY_ENV}=`)) {
          legacySeen = paneReplyDeliveryFromProcessTree(legacy.pid, 'transcript');
          break;
        }
        await new Promise(r => setTimeout(r, 20));
      }
      expect(legacySeen).toBe('transcript');
    } finally {
      withSnapshot.kill('SIGKILL');
      legacy.kill('SIGKILL');
    }
  });
});
