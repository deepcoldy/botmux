import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSerializedBotRenamer, persistRenamedBotName } from '../src/services/bot-name-sync.js';
let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-name-sync-'));
  path = join(root, 'bots.json');
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_a', larkAppSecret: 'fixture', cliId: 'doubao', name: 'old', model: 'keep' },
    { larkAppId: 'cli_b', larkAppSecret: 'fixture', cliId: 'traex', name: 'peer' },
  ]));
});

describe('serialized bot renames', () => {
  it('holds the next remote publish until the prior local persistence completes', async () => {
    const events: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const rename = createSerializedBotRenamer(async name => {
      events.push(`remote:${name}`);
      if (name === 'first') { entered(); await waiting; }
      await persistRenamedBotName('cli_a', name, path);
      events.push(`local:${name}`);
      return name;
    });
    const first = rename('first');
    await started;
    const second = rename('second');
    try {
      await Promise.resolve();
      expect(events).toEqual(['remote:first']);
    } finally {
      release();
    }
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(events).toEqual(['remote:first', 'local:first', 'remote:second', 'local:second']);
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].name).toBe('second');
  });

  it('continues after a failed rename without hiding its rejection', async () => {
    const events: string[] = [];
    const rename = createSerializedBotRenamer(async name => {
      events.push(name);
      if (name === 'failed') throw new Error('remote unavailable');
      return name;
    });
    const first = expect(rename('failed')).rejects.toThrow('remote unavailable');
    const second = rename('next');
    await first;
    expect(await second).toBe('next');
    expect(events).toEqual(['failed', 'next']);
  });

  it('does not serialize independent bot instances behind a blocked rename', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const first = createSerializedBotRenamer(async () => { await waiting; return 'first'; })('first');
    try {
      expect(await createSerializedBotRenamer(async name => name)('other')).toBe('other');
    } finally {
      release();
      await first;
    }
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
describe('persist renamed bot name', () => {
  it('updates only the chosen app and persists for the next reader', async () => {
    expect(await persistRenamedBotName('cli_a', 'New name', path)).toBe('New-name');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
      { larkAppId: 'cli_a', larkAppSecret: 'fixture', cliId: 'doubao', name: 'New-name', model: 'keep' },
      { larkAppId: 'cli_b', larkAppSecret: 'fixture', cliId: 'traex', name: 'peer' },
    ]);
  });
  it('rejects conflicts without modifying the file', async () => {
    const before = readFileSync(path, 'utf8');
    await expect(persistRenamedBotName('cli_a', 'peer', path)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('rejects a missing app without modifying peers', async () => {
    const before = readFileSync(path, 'utf8');
    await expect(persistRenamedBotName('cli_missing', 'new', path)).rejects.toThrow('bot_not_in_config');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it.each(['', '   ', '---', 'botmux-dashboard', 'plugin-demo', 'botmux-plugin-demo'])('rejects an unusable process name %j without persisting it', async name => {
    const before = readFileSync(path, 'utf8');
    await expect(persistRenamedBotName('cli_a', name, path)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('does not rewrite an already synchronized configuration', async () => {
    const before = readFileSync(path, 'utf8');
    expect(await persistRenamedBotName('cli_a', 'old', path)).toBe('old');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
