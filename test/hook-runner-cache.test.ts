import { describe, expect, it, vi } from 'vitest';

describe('loadHookConfigs mtime cache', () => {
  it('reuses file parse results until mtime or size changes', async () => {
    vi.resetModules();

    const reads: string[] = [];
    const files = new Map<string, string>([
      ['/tmp/hooks.json', JSON.stringify([{ event: 'topic.new', command: '/bin/echo one' }])],
    ]);
    let stat = { mtimeMs: 1000, size: files.get('/tmp/hooks.json')!.length };

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn((path: string) => files.has(path)),
      readFileSync: vi.fn((path: string) => {
        reads.push(path);
        return files.get(path) ?? '';
      }),
      statSync: vi.fn(() => stat),
    }));
    vi.doMock('../src/config.js', () => ({
      config: { session: { dataDir: '/tmp' } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));

    const { loadHookConfigs } = await import('../src/services/hook-runner.js');

    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'topic.new', command: '/bin/echo one' }]);

    files.set('/tmp/hooks.json', JSON.stringify([{ event: 'thread.reply', command: '/bin/echo two' }]));
    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'topic.new', command: '/bin/echo one' }]);
    expect(reads).toEqual(['/tmp/hooks.json']);

    stat = { mtimeMs: 2000, size: files.get('/tmp/hooks.json')!.length };
    expect(loadHookConfigs({ env: {} })).toEqual([{ event: 'thread.reply', command: '/bin/echo two' }]);
    expect(reads).toEqual(['/tmp/hooks.json', '/tmp/hooks.json']);
  });

  it('caches BOTMUX_HOOKS_JSON by raw env value', async () => {
    vi.resetModules();

    const { loadHookConfigs } = await import('../src/services/hook-runner.js');
    const env = {
      BOTMUX_HOOKS_JSON: JSON.stringify([{ event: 'outbound.send', command: '/bin/echo one' }]),
    };

    const first = loadHookConfigs({ env });
    const second = loadHookConfigs({ env });

    expect(second).toBe(first);
    env.BOTMUX_HOOKS_JSON = JSON.stringify([{ event: 'outbound.reply', command: '/bin/echo two' }]);
    expect(loadHookConfigs({ env })).toEqual([{ event: 'outbound.reply', command: '/bin/echo two' }]);
  });
});
