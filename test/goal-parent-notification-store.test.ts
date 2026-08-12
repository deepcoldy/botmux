import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  getGoalParentNotification,
  rememberGoalParentNotification,
} from '../src/services/goal-parent-notification-store.js';

let dir: string;
let previousDataDir: string;

beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dir = mkdtempSync(join(tmpdir(), 'goal-parent-notification-'));
  config.session.dataDir = dir;
});

afterEach(() => {
  config.session.dataDir = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('goal parent notification store', () => {
  it('uses a shared recoverable lock so reply-routing records are not lost on mutation', () => {
    const lockPath = join(dir, 'goal-parent-notifications.json.lock');
    writeFileSync(lockPath, '99999999');
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);

    rememberGoalParentNotification({
      messageId: 'om_card', larkAppId: 'cli_main', parentChatId: 'oc_parent',
      goalChatId: 'oc_goal', summary: 'needs decision', createdAt: 1,
    });

    expect(getGoalParentNotification('om_card')).toMatchObject({ goalChatId: 'oc_goal' });
    expect(existsSync(lockPath)).toBe(false);
  });
});
