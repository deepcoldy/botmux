import { describe, expect, it, vi } from 'vitest';
import {
  inspectBotmuxPm2Apps,
  isExactPm2BotActivationReceipt,
  managedActivationPm2Disposition,
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

  it('preserves the generated raw slot and App identity for PM2 start ACKs', () => {
    expect(inspectBotmuxPm2Apps(() => [{
      name: 'botmux-3',
      pm2_env: {
        status: 'online',
        env: {
          BOTMUX_BOT_INDEX: '3',
          BOTMUX_LARK_APP_ID: 'cli_exact_app',
        },
      },
    }])).toEqual({
      ok: true,
      apps: [{
        name: 'botmux-3',
        online: true,
        botIndex: '3',
        larkAppId: 'cli_exact_app',
        activationAppId: undefined,
        activationJobId: undefined,
      }],
    });
  });

  it('preserves a managed activation job receipt from the PM2 environment', () => {
    expect(inspectBotmuxPm2Apps(() => [{
      name: 'botmux-3',
      pm2_env: {
        status: 'online',
        BOTMUX_BOT_INDEX: '3',
        BOTMUX_LARK_APP_ID: 'cli_exact_app',
        BOTMUX_MANAGED_ACTIVATION_APP_ID: 'cli_exact_app',
        BOTMUX_MANAGED_ACTIVATION_JOB_ID: 'botperm_exact_job',
      },
    }])).toEqual({
      ok: true,
      apps: [{
        name: 'botmux-3',
        online: true,
        botIndex: '3',
        larkAppId: 'cli_exact_app',
        activationAppId: 'cli_exact_app',
        activationJobId: 'botperm_exact_job',
      }],
    });
  });

  it('does not accept an ordinary daemon as a gated activation receipt', () => {
    const ordinary = {
      name: 'botmux-3',
      online: true,
      botIndex: '3',
      larkAppId: 'cli_exact_app',
    };
    expect(isExactPm2BotActivationReceipt(
      ordinary,
      'botmux-3',
      3,
      'cli_exact_app',
      'botperm_exact_job',
    )).toBe(false);
    expect(isExactPm2BotActivationReceipt(
      {
        ...ordinary,
        activationAppId: 'cli_exact_app',
        activationJobId: 'botperm_exact_job',
      },
      'botmux-3',
      3,
      'cli_exact_app',
      'botperm_exact_job',
    )).toBe(true);
  });

  it('requires replacing a same App/index ordinary daemon before managed activation', () => {
    const ordinary = [{
      name: 'botmux-3',
      online: true,
      botIndex: '3',
      larkAppId: 'cli_exact_app',
    }];
    expect(managedActivationPm2Disposition(
      ordinary,
      'botmux-3',
      3,
      'cli_exact_app',
      'botperm_exact_job',
    )).toBe('replace');
    expect(managedActivationPm2Disposition(
      [{
        ...ordinary[0],
        activationAppId: 'cli_exact_app',
        activationJobId: 'botperm_exact_job',
      }],
      'botmux-3',
      3,
      'cli_exact_app',
      'botperm_exact_job',
    )).toBe('acknowledged');
    expect(managedActivationPm2Disposition(
      [{ ...ordinary[0], larkAppId: 'other_app' }],
      'botmux-3',
      3,
      'cli_exact_app',
      'botperm_exact_job',
    )).toBe('identity_mismatch');
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
