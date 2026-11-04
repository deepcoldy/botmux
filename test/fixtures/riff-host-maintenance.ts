import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { RiffHostTools } from '../../src/services/riff-host-tools.js';
import { spawnSyncTsEvalWithRepoImports } from '../helpers/ts-runner.js';

async function run(dataDir: string, mode: string) {
  const directory = join(dataDir, 'sessions', 'session-1', 'riff-host-operations');
  fs.mkdirSync(directory, { recursive: true });
  const count = ['stat', 'read', 'rm'].includes(mode) ? 1000 : 1;
  for (let i = 0; i < count; i++) fs.writeFileSync(join(directory, `${i.toString(16).padStart(64, '0')}.json`),
    JSON.stringify({ turnId: 'old-turn', fingerprint: 'a'.repeat(64) }));
  const originals = { mkdir: fs.mkdirSync, readdir: fs.readdirSync, stat: fs.statSync, read: fs.readFileSync, rm: fs.rmSync };
  let removed = false;
  const fail = (code: string): never => { throw Object.assign(new Error('injected filesystem failure'), { code }); };
  fs.mkdirSync = ((path, ...args) => String(path) === directory && mode === 'mkdir'
    ? fail('ENOSPC') : (originals.mkdir as any)(path, ...args)) as typeof fs.mkdirSync;
  fs.readdirSync = ((path, ...args) => {
    if (String(path) !== directory) return (originals.readdir as any)(path, ...args);
    if (mode === 'readdir') fail('EACCES');
    const entries = (originals.readdir as any)(path, ...args);
    if (mode === 'race' && !removed) {
      // Stop exactly between worker readdir and stat. A separate real process
      // executes the daemon's orphan cleanup, reproducing the reported race.
      const child = spawnSyncTsEvalWithRepoImports(`
        import { sweepOrphanRiffHostReceiptDirs } from './src/core/riff-host-receipt-cleanup.js';
        const removed = await sweepOrphanRiffHostReceiptDirs(process.env.FIXTURE_DATA_DIR, new Set(), {
          liveReferences: async () => new Set(), graceMs: 0, now: Date.now() + 60_000,
        });
        process.stdout.write(JSON.stringify(removed.length));
      `, { env: { ...process.env, FIXTURE_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 15_000 });
      if (child.status !== 0 || child.stdout !== '1') throw new Error(`cleanup child failed: ${child.stderr}`);
      removed = true;
    }
    return entries;
  }) as typeof fs.readdirSync;
  fs.statSync = ((path, ...args) => String(path).startsWith(`${directory}/`) && mode === 'stat'
    ? fail('EACCES') : (originals.stat as any)(path, ...args)) as typeof fs.statSync;
  fs.readFileSync = ((path, ...args) => String(path).startsWith(`${directory}/`) && mode === 'read' && fs.existsSync(path)
    ? fail('EIO') : (originals.read as any)(path, ...args)) as typeof fs.readFileSync;
  fs.rmSync = ((path, ...args) => String(path).startsWith(`${directory}/`) && mode === 'rm'
    ? fail('EACCES') : (originals.rm as any)(path, ...args)) as typeof fs.rmSync;
  syncBuiltinESMExports();

  let executed = 0;
  const gateway = new RiffHostTools(async () => { executed++; return { exitCode: 0, stdout: 'ok', stderr: '' }; });
  const server = createServer((req, res) => { void gateway.handle(req, res); });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/riff-host-tools`;
    const binding = gateway.bind(url, { dataDir, sessionId: 'session-1', turnId: 'turn-1', env: {}, isCurrent: () => true });
    let response = await fetch(url, { method: 'POST', headers: { 'x-riff-host-token': binding.token },
      body: JSON.stringify({ operationId: 'operation-new', argv: ['project', 'status'] }) });
    await response.text();
    if (response.status === 202) {
      response = await fetch(`${url}?operationId=operation-new`, { headers: { 'x-riff-host-token': binding.token } });
      await response.text();
    }
    return { mode, status: response.status, executed, removed };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.mkdirSync = originals.mkdir;
    fs.readdirSync = originals.readdir;
    fs.statSync = originals.stat;
    fs.readFileSync = originals.read;
    fs.rmSync = originals.rm;
    syncBuiltinESMExports();
  }
}

// One Node/tsx startup for the entire fault matrix. Each case has separate
// storage and restores its fs patches before the next case starts.
const results = [];
for (const mode of ['mkdir', 'readdir', 'stat', 'read', 'rm', 'race']) {
  results.push(await run(join(process.argv[2]!, mode), mode));
}
process.stdout.write(JSON.stringify(results));
