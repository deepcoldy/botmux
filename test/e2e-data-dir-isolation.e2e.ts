import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';

function inside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Captured at MODULE IMPORT time. setupFiles run before this module is imported,
// so this pins the fence for module-scope code (which may open a store at import,
// the way some src/ modules do): a beforeEach repair cannot cover that window.
const importTimeDataDir = config.session.dataDir;

describe('e2e project data-dir fence', () => {
  it('gives every e2e file a disposable SESSION_DATA_DIR, never the invoking one', () => {
    const root = inject('testSessionDataRoot');
    const dataDir = config.session.dataDir;
    expect(inside(importTimeDataDir, root)).toBe(true);
    expect(inside(dataDir, root)).toBe(true);
    expect(inside(dataDir, process.env.__TEST_DATA_DIR_FENCE ?? '/nonexistent')).toBe(true);

    sessionStore.init('e2e_isolation_probe');
    sessionStore.createSession('oc_probe', 'om_probe', 'e2e isolation probe');
    expect(existsSync(join(dataDir, 'session-stores', 'e2e_isolation_probe', 'sessions.db'))).toBe(true);
  });
});
