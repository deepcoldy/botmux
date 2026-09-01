import { describe, expect, it } from 'bun:test';
import { selectRunningManualPluginServiceIds } from '../src/core/plugins/service-manager.js';
import type { InstalledPluginRecord } from '../src/core/plugins/types.js';

function record(id: string, mode: 'auto' | 'manual'): InstalledPluginRecord {
  return { id, manifest: { service: { mode } } } as InstalledPluginRecord;
}

describe('manual plugin service snapshot', () => {
  it('keeps only live manual services for restoration after God rotation', () => {
    const records = [
      record('manual-online', 'manual'),
      record('manual-launching', 'manual'),
      record('manual-stopped', 'manual'),
      record('auto-online', 'auto'),
    ];

    expect(selectRunningManualPluginServiceIds(records, [
      { name: 'botmux-plugin-manual-online', pid: 101, status: 'online' },
      { name: 'botmux-plugin-manual-launching', pid: 0, status: 'launching' },
      { name: 'botmux-plugin-manual-stopped', pid: 0, status: 'stopped' },
      { name: 'botmux-plugin-auto-online', pid: 202, status: 'online' },
    ])).toEqual(['manual-online', 'manual-launching']);
  });
});
