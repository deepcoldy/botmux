import { describe, expect, it } from 'vitest';
import { defaultWorkbenchLayout } from '../src/dashboard/web/agent-workbench-model.js';
import {
  loadWorkbenchLayout,
  saveWorkbenchLayout,
  workbenchLayoutStorageKey,
  type WorkbenchStorage,
} from '../src/dashboard/web/agent-workbench-storage.js';

class MemoryStorage implements WorkbenchStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('Agent Workbench layout persistence', () => {
  it('persists independently per session and never serializes capabilities or URLs', () => {
    const storage = new MemoryStorage();
    const first = { ...defaultWorkbenchLayout(), paneMode: 'split' as const, splitAxis: 'vertical' as const, chatRequested: true };
    expect(saveWorkbenchLayout('a/b', first, storage)).toBe(true);
    expect(loadWorkbenchLayout('a/b', storage)).toEqual(first);
    expect(loadWorkbenchLayout('other', storage)).toEqual(defaultWorkbenchLayout());
    const raw = storage.values.get(workbenchLayoutStorageKey('a/b'))!;
    expect(raw).not.toMatch(/url|token|grant|cookie|previewPath|terminalHref/i);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'chatRequested', 'focus', 'paneMode', 'railCollapsed', 'railWidth', 'splitAxis', 'splitRatio', 'version',
    ]);
  });

  it('fails closed to defaults for corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(workbenchLayoutStorageKey('bad'), '{broken');
    expect(loadWorkbenchLayout('bad', storage)).toEqual(defaultWorkbenchLayout());
  });
});
