import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSandboxConfigOnDisk } from '../src/services/sandbox-migration.js';

let dir: string;
let botsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbx-mig-'));
  botsPath = join(dir, 'bots.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (entries: any[]) => writeFileSync(botsPath, JSON.stringify(entries, null, 2));
const read = () => JSON.parse(readFileSync(botsPath, 'utf-8'));

describe('migrateSandboxConfigOnDisk', () => {
  it('migrates legacy fields to sandboxPaths, KEEPS old fields, creates backup', async () => {
    write([{
      larkAppId: 'cli_a', larkAppSecret: 's',
      sandbox: true,
      sandboxReadonlyPaths: ['~/ref'],
      sandboxHidePaths: ['~/.ssh'],
      customUnknownField: { keep: 'me' },
    }]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual(['cli_a']);
    const [e] = read();
    expect(e.sandbox).toBe(true);
    expect(e.sandboxPaths).toEqual({ readOnly: ['~/ref'], deny: ['~/.ssh'] });
    // old fields preserved for downgrade
    expect(e.sandboxReadonlyPaths).toEqual(['~/ref']);
    expect(e.sandboxHidePaths).toEqual(['~/.ssh']);
    // unknown fields survive the rewrite
    expect(e.customUnknownField).toEqual({ keep: 'me' });
    // backup created with the ORIGINAL (pre-migration) content
    const bak = `${botsPath}.bak-sandbox-v1`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, 'utf-8'))[0].sandboxPaths).toBeUndefined();
  });

  it('absorbs readIsolation:true into sandbox:true', async () => {
    write([{ larkAppId: 'cli_b', larkAppSecret: 's', readIsolation: true, readDenyExtraPaths: ['~/x'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const [e] = read();
    expect(e.sandbox).toBe(true);
    expect(e.readIsolation).toBe(true); // kept for downgrade
    expect(e.sandboxPaths).toEqual({ deny: ['~/x'] });
  });

  it('is idempotent: second run migrates nothing and leaves the file unchanged', async () => {
    write([{ larkAppId: 'cli_a', larkAppSecret: 's', sandbox: true, sandboxHidePaths: ['~/.aws'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const after1 = readFileSync(botsPath, 'utf-8');
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(readFileSync(botsPath, 'utf-8')).toBe(after1);
  });

  it('does not touch entries with nothing to migrate (plain sandbox / no sandbox)', async () => {
    write([
      { larkAppId: 'cli_plain', larkAppSecret: 's', sandbox: true },
      { larkAppId: 'cli_none', larkAppSecret: 's' },
    ]);
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
    expect(existsSync(`${botsPath}.bak-sandbox-v1`)).toBe(false);
    expect(read()[0].sandboxPaths).toBeUndefined();
  });

  it('never throws on malformed json (startup must not brick)', async () => {
    writeFileSync(botsPath, '{not json');
    const { migrated } = await migrateSandboxConfigOnDisk(botsPath);
    expect(migrated).toEqual([]);
  });

  it('backup is written only once (first migration wins)', async () => {
    write([{ larkAppId: 'cli_a', larkAppSecret: 's', sandbox: true, sandboxHidePaths: ['~/.aws'] }]);
    await migrateSandboxConfigOnDisk(botsPath);
    const bakContent = readFileSync(`${botsPath}.bak-sandbox-v1`, 'utf-8');
    // simulate a later legacy edit + re-migration
    const entries = read();
    entries.push({ larkAppId: 'cli_late', larkAppSecret: 's', readIsolation: true });
    write(entries);
    await migrateSandboxConfigOnDisk(botsPath);
    expect(readFileSync(`${botsPath}.bak-sandbox-v1`, 'utf-8')).toBe(bakContent);
  });
});
