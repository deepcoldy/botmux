import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('LinkRefLedger under Bun SQLite', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reopens and resolves the exact original URL under the pinned Bun runtime', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-ledger-bun-'));
    dirs.push(dataDir);
    const url = 'https://example.test/p';
    const source = `
      import { LinkRefLedger } from './src/services/link-ref-ledger.js';
      const key = { appId: 'app', sessionId: 'session', turnId: 'turn', dispatchAttempt: 2 };
      let ledger = new LinkRefLedger(process.env.LINK_REF_TEST_DATA_DIR);
      ledger.openTurn(key);
      const refId = ledger.registerBatch(key, [{ originalUrl: process.env.LINK_REF_TEST_URL, sourceType: 'tool' }]).registered[0].refId;
      ledger.close();
      ledger = new LinkRefLedger(process.env.LINK_REF_TEST_DATA_DIR);
      const resolved = ledger.resolveBatch(key, [refId]).get(refId);
      ledger.close();
      console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', bunVersion: Bun.version, resolved }));
    `;
    const child = spawnSyncBunTsEvalWithRepoImports(source, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        LINK_REF_TEST_DATA_DIR: dataDir,
        LINK_REF_TEST_URL: url,
      },
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    const packageManager = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).packageManager;
    expect(result).toEqual({ runtime: 'bun', bunVersion: packageManager.replace('bun@', ''), resolved: url });
  });
});
