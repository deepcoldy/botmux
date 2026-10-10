import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], body?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-send-dry-run-'));
  try {
    const file = join(dir, 'body.md');
    if (body !== undefined) writeFileSync(file, body);
    const resolved = args.map(arg => (arg === '@body' ? file : arg));
    // No session, relay or bot configuration: a dry run must not need any.
    return spawnSyncTsScript(cli, resolved, {
      env: { PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json') },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const chartBody = [
  '## 标题',
  '```vega-lite',
  '{"title":"T","data":{"values":[{"d":"a","v":1}]},"mark":"bar","encoding":{"x":{"field":"d"},"y":{"field":"v"}}}',
  '```',
].join('\n');

describe('send --dry-run', () => {
  it('renders the body to card JSON without any session or transport', () => {
    const result = run(['send', '--dry-run', '--content-file', '@body'], chartBody);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dryRun).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.card.schema).toBe('2.0');
    expect(output.card.body.elements.map((element: { tag: string }) => element.tag)).toEqual(['markdown', 'chart']);
    // Sized like the Feishu request (envelope + re-serialized content), so
    // strictly larger than the bare card JSON.
    expect(output.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(output.card)));
    expect(output.fits).toBe(true);
  });

  it('accepts positional content', () => {
    const result = run(['send', '--dry-run', '**加粗**']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({ tag: 'markdown', content: '**加粗**' });
  });

  it('reports degraded charts on stderr and in the JSON', () => {
    const body = '```vega-lite\n{"title":"远程","data":{"url":"http://evil.example"},"mark":"bar"}\n```';
    const result = run(['send', '--dry-run', '--content-file', '@body'], body);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('图表「远程」已降级为数据表（data_url_not_allowed）');
    expect(JSON.parse(result.stdout).diagnostics).toEqual([{ kind: 'chart_degraded', reason: 'data_url_not_allowed', title: '远程' }]);
  });

  it('previews post-JSON bodies the same way a real send extracts them', () => {
    const post = JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: '**加粗**' }]] } });
    const result = run(['send', '--dry-run', '--content-file', '@body'], post);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({ tag: 'markdown', content: '**加粗**' });
  });

  it('refuses custom cards and empty bodies', () => {
    const custom = run(['send', '--dry-run', '--card-json', '{"schema":"2.0"}']);
    expect(custom.status).toBe(2);
    expect(custom.stderr).toContain('不能与 --card-file/--card-json 混用');
    const empty = run(['send', '--dry-run', '--content-file', '@body'], '   ');
    expect(empty.status).toBe(2);
  });

  it('is documented in send help', () => {
    const result = run(['send', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('```vega-lite');
  });
});
