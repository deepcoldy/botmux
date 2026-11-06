import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { config } from '../src/config.js';
import * as sessionStore from '../src/services/session-store.js';

function inside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('e2e project data-dir fence', () => {
  it('gives every e2e file a disposable SESSION_DATA_DIR, never the invoking one', () => {
    const root = inject('unitSessionDataRoot');
    const dataDir = config.session.dataDir;
    expect(inside(dataDir, root)).toBe(true);
    expect(inside(dataDir, process.env.__TEST_DATA_DIR_FENCE ?? '/nonexistent')).toBe(true);

    sessionStore.init('e2e_isolation_probe');
    sessionStore.createSession('oc_probe', 'om_probe', 'e2e isolation probe');
    expect(existsSync(join(dataDir, 'session-stores', 'e2e_isolation_probe', 'sessions.db'))).toBe(true);
  });
});
