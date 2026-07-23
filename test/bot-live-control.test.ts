import { describe, expect, it, vi } from 'vitest';
import {
  inspectBotmuxPm2Apps,
  parsePm2JlistOutputStrict,
  stopExactPm2Process,
} from '../src/core/bot-live-control.js';

describe('exact bot PM2 live control', () => {
  it('rejects a valid JSON top-level value that is not the PM2 process array', () => {
    expect(() => parsePm2JlistOutputStrict('{}')).toThrow('pm2_jlist_json_not_found');
    expect(() => parsePm2JlistOutputStrict('null')).toThrow('pm2_jlist_json_not_found');
    expect(parsePm2JlistOutputStrict('[PM2] status follows\n[{"name":"botmux-3"}]')).toEqual([
      { name: 'botmux-3' },
    ]);
  });

  it('keeps a PM2 query failure distinct from confirmed process absence', () => {
    expect(inspectBotmuxPm2Apps(() => {
      throw new Error('pm2 jlist timed out');
    })).toEqual({
      ok: false,
      message: 'pm2 jlist timed out',
    });
  });

  it('rejects malformed PM2 rows instead of treating them as exact absence', () => {
    expect(inspectBotmuxPm2Apps(() => [{}])).toEqual({
      ok: false,
      message: 'pm2 jlist contains a malformed process row',
    });
    expect(inspectBotmuxPm2Apps(() => [null])).toEqual({
      ok: false,
      message: 'pm2 jlist contains a malformed process row',
    });
    const remove = vi.fn();
    expect(stopExactPm2Process(
      'botmux-3',
      () => inspectBotmuxPm2Apps(() => [{}]),
      remove,
    )).toEqual({
      ok: false,
      reason: 'pm2_error',
      message: 'pm2 jlist contains a malformed process row',
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('requires a successful exact-absence readback after delete', () => {
    const list = vi.fn()
      .mockReturnValueOnce({
        ok: true,
        apps: [{ name: 'botmux-3', online: true }],
      })
      .mockImplementationOnce(() => inspectBotmuxPm2Apps(() => [{}]));
    const remove = vi.fn();

    expect(stopExactPm2Process('botmux-3', list, remove)).toEqual({
      ok: false,
      reason: 'pm2_error',
      message: 'pm2 jlist contains a malformed process row',
    });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('acknowledges stopped only after the exact row is absent on readback', () => {
    const list = vi.fn()
      .mockReturnValueOnce({
        ok: true,
        apps: [{ name: 'botmux-3', online: true }],
      })
      .mockReturnValueOnce({
        ok: true,
        apps: [{ name: 'botmux-dashboard', online: true }],
      });
    const remove = vi.fn();

    expect(stopExactPm2Process('botmux-3', list, remove)).toEqual({
      ok: true,
      state: 'stopped',
      processName: 'botmux-3',
    });
  });
});
