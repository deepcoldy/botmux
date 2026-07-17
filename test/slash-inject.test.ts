import { describe, expect, it } from 'vitest';
import { validateSlashInjection } from '../src/core/slash-inject.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

describe('validateSlashInjection', () => {
  const allow = ['/compact', '/model'];
  it('放行 allowlist 内的单行斜杠命令（带参数）', () => {
    expect(validateSlashInjection('/model opus', allow)).toEqual({ ok: true, command: '/model opus' });
  });
  it('拒绝非斜杠开头 / 多行 / 空串', () => {
    expect(validateSlashInjection('rm -rf /', allow).ok).toBe(false);
    expect(validateSlashInjection('/compact\n恶意第二行', allow).ok).toBe(false);
    expect(validateSlashInjection('  ', allow).ok).toBe(false);
  });
  it('/cd 固定禁止——即使在 allowlist 里', () => {
    const r = validateSlashInjection('/cd /tmp', ['/cd']);
    expect(r).toEqual({ ok: false, error: 'command_forbidden' });
  });
  it('allowlist 缺省/为空 → 全拒（默认关闭）', () => {
    expect(validateSlashInjection('/compact', undefined).ok).toBe(false);
    expect(validateSlashInjection('/compact', []).ok).toBe(false);
  });
  it('不在 allowlist 内 → 拒绝', () => {
    expect(validateSlashInjection('/logout', allow)).toEqual({ ok: false, error: 'not_in_allowlist' });
  });
});

describe('bots.json tuiSlashAllow 解析', () => {
  it('归一化：补斜杠、去重、丢弃非法项', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 's',
      tuiSlashAllow: ['compact', '/Model', '/compact', 'bad name!', 42],
    }]));
    expect(cfgs[0].tuiSlashAllow).toEqual(['/compact', '/model']);
  });
  it('缺省为 undefined', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 's' }]));
    expect(cfgs[0].tuiSlashAllow).toBeUndefined();
  });
});
