import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { spawnTsScript } from './helpers/ts-runner.js';

let root: string;
let dataDir: string;
const children = new Set<ChildProcess>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const searchSchema = z.object({
  schema: z.literal('botmux.topic-search.v1'),
  results: z.array(z.object({ anchor: z.string(), hits: z.object({ count: z.number() }) })),
});
beforeEach(() => {
  root = mkdtempSync(join(homedir(), 'topic-e2e-'));
  dataDir = join(root, 'data');
  mkdirSync(join(dataDir, 'queues'), { recursive: true });
  mkdirSync(join(dataDir, 'turn-sends'));
});
afterEach(async () => {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }));
  children.clear();
  rmSync(root, { recursive: true, force: true });
});
function spawn(script: string, args: string[]) {
  const child = spawnTsScript(resolve(script), args, {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, USERPROFILE: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_TOPIC_SEARCH: '1', BOTMUX_SESSION_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
function cli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn('src/cli.ts', ['topic', ...args]);
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timeout: ${args.join(' ')}\n${err}`)); }, 20_000);
    child.stdout?.on('data', chunk => { out += String(chunk); });
    child.stderr?.on('data', chunk => { err += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function indexer() {
  const child = spawn('src/index-topic-indexer.ts', []);
  let errors = '';
  child.stdout?.resume();
  child.stderr?.on('data', chunk => { errors += String(chunk); });
  child.on('error', error => { errors += error.message; });
  return { child, errors: () => errors };
}
async function waitFor(check: () => Promise<boolean>, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('topic e2e condition did not converge');
}
function inbound(id: string, content: string) {
  return JSON.stringify({ messageId: id, content, createTime: Date.now(), senderType: 'user' }) + '\n';
}
function sourceSnapshot() {
  const files = new Map<string, { bytes: Buffer; mtime: number }>();
  function visit(directory: string) {
    for (const entry of readdirSync(join(dataDir, directory), { withFileTypes: true })) {
      if (!directory && entry.name === 'topic-search') continue;
      const relative = join(directory, entry.name);
      if (entry.isDirectory()) visit(relative);
      else files.set(relative, { bytes: readFileSync(join(dataDir, relative)), mtime: statSync(join(dataDir, relative)).mtimeMs });
    }
  }
  visit('');
  return files;
}

describe('topic search with real CLI and indexer processes', () => {
  it('finds messages and removes closed-topic replies within seconds without changing sources', async () => {
    writeFileSync(join(dataDir, 'queues/om_root.jsonl'), inbound('om_question', 'e2equestion 风险'));
    const replies = join(dataDir, 'turn-sends/session_e2e.jsonl');
    writeFileSync(replies, JSON.stringify({ sessionId: 'session_e2e', messageId: 'om_answer',
      targetRootMessageId: 'om_root', sentAtMs: Date.now(), previewText: 'e2eanswer 独有回复' }) + '\n');
    const before = sourceSnapshot();
    const running = indexer();
    await waitFor(async () => (await cli(['search', 'e2eanswer'])).code === 0);
    const result = await cli(['search', '风险']);
    expect(result.code, result.err + running.errors()).toBe(0);
    expect(searchSchema.parse(JSON.parse(result.out)).results[0].anchor).toBe('om_root');
    expect(sourceSnapshot()).toEqual(before);
    rmSync(replies);
    const afterDelete = sourceSnapshot();
    await waitFor(async () => (await cli(['search', 'e2eanswer'])).code === 1, 8000);
    expect((await cli(['search', 'e2equestion'])).code).toBe(0);
    expect(sourceSnapshot()).toEqual(afterDelete);
    expect(running.child.exitCode, running.errors()).toBeNull();
  }, 60_000);

  it('serializes background synchronization with reindex and permits queries during writes without duplicates', async () => {
    const path = join(dataDir, 'queues/om_root.jsonl');
    writeFileSync(path, inbound('om_initial', 'e2econcurrent initial'));
    const running = indexer();
    await waitFor(async () => (await cli(['search', 'e2econcurrent'])).code === 0);
    // More than one source page keeps the real writer busy without mocking it.
    const rows = Array.from({ length: 5000 }, (_, i) => inbound(`om_bulk_${i}`, `e2econcurrent payload ${i}`)).join('');
    appendFileSync(path, rows);
    let appended = 0;
    let stopWriting = false;
    const writer = (async () => {
      do {
        appendFileSync(path, inbound(`om_live_${appended}`, 'e2econcurrent live'));
        appended++;
        await delay(100);
      } while (!stopWriting);
    })();
    try {
      const reindex = (async () => {
        for (let pass = 0; pass < 3; pass++) {
          const result = await cli(['reindex']);
          expect(result.code, result.err).toBe(0);
          if (pass < 2) await delay(2100);
        }
      })();
      const queries = Promise.all(Array.from({ length: 3 }, async () => {
        const result = await cli(['search', 'e2econcurrent']);
        expect(result.code, result.err).toBe(0);
        expect(searchSchema.parse(JSON.parse(result.out)).results[0].anchor).toBe('om_root');
      }));
      await Promise.all([reindex, queries]);
    } finally { stopWriting = true; await writer; }
    const expectedCount = 5001 + appended;
    const expectedSources = sourceSnapshot();
    await waitFor(async () => {
      const result = await cli(['search', 'e2econcurrent']);
      if (result.code !== 0) return false;
      const value = searchSchema.parse(JSON.parse(result.out));
      return value.results.length === 1 && value.results[0].hits.count === expectedCount;
    });
    // A second independent CLI writer must preserve the same exact count.
    const second = await cli(['reindex']); expect(second.code, second.err).toBe(0);
    const final = await cli(['search', 'e2econcurrent']);
    expect(searchSchema.parse(JSON.parse(final.out)).results).toMatchObject([{ hits: { count: expectedCount } }]);
    expect(sourceSnapshot()).toEqual(expectedSources);
    expect(running.child.exitCode, running.errors()).toBeNull();
  }, 90_000);
});
