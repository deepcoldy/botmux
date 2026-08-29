import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

function pinnedBunVersion(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const match = /^bun@(.+)$/.exec(pkg.packageManager ?? '');
  if (!match) throw new Error(`packageManager is not pinned to Bun: ${pkg.packageManager}`);
  return match[1];
}

describe('first-start JSON import under Bun', () => {
  it('publishes a complete store without temporary SQLite sidecars', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sqlite-import-bun-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sqlite-import-home-'));
    try {
      const rows: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) {
        rows[`s${i}`] = {
          sessionId: `s${i}`,
          chatId: 'oc_chat',
          rootMessageId: `om_s${i}`,
          title: `t${i}`,
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          scope: 'topic',
        };
      }
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(rows));

      const storeModule = join(process.cwd(), 'src', 'services', 'session-store.ts');
      const source = `
        const store = await import(${JSON.stringify(storeModule)});
        store.init('appA');
        console.log(JSON.stringify({
          runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
          bunVersion: typeof Bun === 'undefined' ? null : Bun.version,
          visible: store.listSessions().length,
        }));
      `;
      const child = spawnSyncBunTsEvalWithRepoImports(source, {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          SESSION_DATA_DIR: dataDir,
        },
      });

      expect(child.error).toBeUndefined();
      expect(child.status, String(child.stderr)).toBe(0);
      const resultLine = String(child.stdout)
        .split('\n')
        .findLast(line => line.trim().startsWith('{'));
      expect(resultLine, `Bun child produced no result. stderr:\n${child.stderr}`).toBeTruthy();
      const result = JSON.parse(resultLine!) as {
        runtime: string;
        bunVersion: string | null;
        visible: number;
      };

      expect(result.runtime).toBe('bun');
      expect(result.bunVersion).toBe(pinnedBunVersion());
      expect(result.visible).toBe(40);

      const storeDir = join(dataDir, 'session-stores', 'appA');
      expect(readdirSync(storeDir).filter(name => name.includes('.tmp'))).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
