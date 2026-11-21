import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTraexModelLoadSnapshot } from '../src/services/traex-model-load.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'native-catalog-reader-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function read(pages: unknown[], signal?: AbortSignal) {
  const cli = join(dir, 'native-catalog-stub');
  writeFileSync(cli, `#!/usr/bin/env node
const pages = ${JSON.stringify(pages)}; let page = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
  if (msg.method === 'model/list') process.stdout.write(JSON.stringify({id:msg.id,...pages[page++]})+'\\n');
});
`);
  chmodSync(cli, 0o700);
  // Allow normal child startup under a loaded test host; protocol failures
  // still terminate immediately rather than succeeding via this deadline.
  return readTraexModelLoadSnapshot({ cliBin: cli, cwd: dir, timeoutMs: 8_000, signal });
}

describe.skipIf(process.platform === 'win32')('complete native catalog proof (POSIX executable fixture)', () => {
  it('does not launch a helper after cancellation', async () => {
    const abort = new AbortController(); abort.abort();
    // An executable helper with a valid catalog makes accidental spawning
    // observable; a missing binary would also return null without the guard.
    expect(await read([{ result: { data: [{ id: 'core' }], nextCursor: null } }], abort.signal)).toBeNull();
  });
  it('collects public identities without requiring load or reasoning metadata', async () => {
    const result = await read([
      { result: { data: [{ id: 'core-id', model: 'CORE', displayName: 'Core Model' }], nextCursor: 'page2' } },
      { result: { data: [{ id: 'backup' }], nextCursor: null } },
    ]);
    expect([...result!.catalogModels!]).toEqual(['core-id', 'core', 'core model', 'backup']);
    expect(result!.loads.size).toBe(0);
  });

  it.each([
    [{ result: { data: [], nextCursor: null } }],
    [{ result: { data: [{ id: 'core' }], nextCursor: 'page2' } }, { error: { code: -1 } }],
    [{ result: { data: [{ id: 'core' }], nextCursor: 'same' } }, { result: { data: [{ id: 'backup' }], nextCursor: 'same' } },
      { result: { data: [{ id: 'last' }], nextCursor: null } }],
    [{ result: { data: [{ id: 'core' }, {}], nextCursor: null } }],
    [{ result: { data: [{ id: 'core' }], nextCursor: 12 } }],
    [{ result: {} }],
  ])('does not authorize removal from empty, malformed or incomplete responses (%j)', async (...pages) => {
    expect(await read(pages)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('unavailable catalog reads say why (POSIX executable fixture)', () => {
  // A null read is indistinguishable from "the helper answered too late" or
  // "the helper never started" unless the reader says which step it reached.
  function stub(body: string): string {
    const cli = join(dir, 'native-catalog-reason-stub');
    writeFileSync(cli, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(cli, 0o700);
    return cli;
  }
  const answerInitializeOnly = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
});`;

  it('names the protocol step a timed-out read was waiting on', async () => {
    const reasons: string[] = [];
    const result = await readTraexModelLoadSnapshot({
      cliBin: stub(answerInitializeOnly), cwd: dir, timeoutMs: 1_500, onUnavailable: reason => reasons.push(reason),
    });
    expect(result).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^timed out after 1500ms \(waiting for model\/list page 1\); \d+ms after launch$/);
  });

  it('reports a helper that exits before answering, with its exit status', async () => {
    const reasons: string[] = [];
    const result = await readTraexModelLoadSnapshot({
      // Exit only after initialize arrived: the reader then writes nothing more,
      // so the exit itself (not an EPIPE on a later write) ends the read.
      cliBin: stub(`process.stdin.once('data', () => process.exit(3));`), cwd: dir, timeoutMs: 8_000,
      onUnavailable: reason => reasons.push(reason),
    });
    expect(result).toBeNull();
    expect(reasons).toEqual([expect.stringMatching(/^helper exited \(code=3, signal=null\) while helper started, no reply yet; \d+ms after launch$/)]);
  });

  it('reports nothing for a complete catalog', async () => {
    const reasons: string[] = [];
    const result = await readTraexModelLoadSnapshot({
      cliBin: stub(`require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
  if (msg.method === 'model/list') process.stdout.write(JSON.stringify({id:msg.id,result:{data:[{id:'core'}],nextCursor:null}})+'\\n');
});`), cwd: dir, timeoutMs: 8_000, onUnavailable: reason => reasons.push(reason),
    });
    expect([...result!.catalogModels!]).toEqual(['core']);
    expect(reasons).toEqual([]);
  });
});
