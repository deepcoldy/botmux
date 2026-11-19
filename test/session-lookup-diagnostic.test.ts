import { describe, expect, it } from 'vitest';
import { formatSessionLookupMissLine } from '../src/cli/session-lookup-diagnostic.js';

const baseInput = {
  sessionId: 's1',
  source: 'env',
  dataDir: '/tmp/bm/.botmux/data',
  reason: 'not_found',
  cliVersion: '3.56.0',
  relayPresent: false,
  readIsolation: 'off' as const,
  capabilityPresent: false,
};

describe('formatSessionLookupMissLine audience split (design doc 2026-08-12 §3.6)', () => {
  it('shows the CLI build and per-daemon versions in an operator shell', () => {
    const line = formatSessionLookupMissLine({
      ...baseInput,
      diagnostics: { askedDaemons: [{ appId: 'cli_a', version: '3.50.0' }], ownerAppId: 'cli_b' },
    }, {});
    expect(line).toContain('cliVersion=3.56.0');
    expect(line).toContain('askedDaemons=cli_a@3.50.0');
    expect(line).toContain('storeOwnerAppId=cli_b');
    expect(line).toContain('context=host');
  });

  it('hides every version number from a session subprocess, keeping the app id', () => {
    for (const env of [
      { BOTMUX_SESSION_ID: 'sess-1' },
      { BOTMUX_ORIGIN_CHANNEL_ID: 'oc_o' },
    ]) {
      const line = formatSessionLookupMissLine({
        ...baseInput,
        diagnostics: { askedDaemons: [{ appId: 'cli_a', version: '3.50.0' }], ownerAppId: 'cli_b' },
      }, env);
      expect(line).toContain('askedDaemons=cli_a');
      expect(line).not.toContain('@3.50.0');
      expect(line).not.toContain('3.50.0');
      expect(line).not.toContain('3.56.0');
      expect(line).toContain('cliVersion=-');
      // app ids and routing fields survive
      expect(line).toContain('storeOwnerAppId=cli_b');
      expect(line).toContain('sessionId=s1');
    }
  });

  it('classifies a host-relay re-exec (which carries BOTMUX_SESSION_ID) as session-scoped', () => {
    const line = formatSessionLookupMissLine({
      ...baseInput,
      diagnostics: { askedDaemons: [{ appId: 'cli_a', version: '3.50.0' }] },
    }, { BOTMUX_SESSION_ID: 'sess-1', BOTMUX_HOST_RELAY_AUTHORIZED: '1' });
    expect(line).toContain('context=host-relay');
    expect(line).toContain('cliVersion=-');
    expect(line).not.toContain('3.50.0');
  });

  it('renders no asked daemons as a dash', () => {
    const line = formatSessionLookupMissLine(baseInput, {});
    expect(line).toContain('askedDaemons=-');
    expect(line).toContain('storeOwnerAppId=-');
  });
});
