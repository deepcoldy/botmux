import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { logger } from '../src/utils/logger.js';

describe('substitute App ID config load warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  const appIdWarnings = () => warnSpy.mock.calls.map(call => String(call[0])).filter(line => line.includes('invalid appId'));
  const parse = (appId: unknown) => parseBotConfigsFromText(JSON.stringify([{
    larkAppId: 'cli_appid_warn', larkAppSecret: 's',
    substituteMode: { enabled: true, targets: [{ appId }, { appId: 'cli_ok' }] },
  }]))[0];

  it('warns once per bot and value while still dropping the invalid target', () => {
    expect(parse('cli-bad').substituteMode?.targets).toEqual([{ appId: 'cli_ok' }]);
    parse('cli-bad');
    expect(appIdWarnings()).toEqual([expect.stringContaining('[substitute:cli_appid_warn]')]);
    expect(appIdWarnings()[0]).toContain('"cli-bad"');
    parse('cli-also-bad');
    expect(appIdWarnings()).toHaveLength(2);
  });

  it('stays silent for a valid App ID', () => {
    parse('CLI_Valid');
    expect(appIdWarnings()).toEqual([]);
  });
});
