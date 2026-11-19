import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { classifyRemoteRunnerOutboundHostResult } from '../src/services/remote-runner-outbound-send.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], body?: string, input?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-send-dry-run-'));
  try {
    const file = join(dir, 'body.md');
    if (body !== undefined) writeFileSync(file, body);
    const resolved = args.map(arg => (arg === '@body' ? file : arg));
    // No session, relay or bot configuration: a dry run must not need any.
    return spawnSyncTsScript(cli, resolved, {
      env: { PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json') },
      ...(input !== undefined ? { input } : {}),
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

  it('previews positional paragraph escapes the same way as a real send', () => {
    const result = run(['send', '--dry-run', '第一段\\n\\n第二段']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: '第一段\n\n第二段',
    });
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

  it('renders a lone dash from stdin', () => {
    const result = run(['send', '--dry-run', '--no-mention', '-'], undefined, 'REAL BODY');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'REAL BODY' });
  });

  it('reads stdin for a lone dash even when attachment flags are present', () => {
    const result = run(['send', '--dry-run', '--no-mention', '--images', '/tmp/not-used.png', '-'], undefined, 'REAL BODY');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'REAL BODY' });
  });

  it('rejects a dash mixed with other body tokens', () => {
    const result = run(['send', '--dry-run', '--no-mention', '-', 'extra'], undefined, 'REAL BODY');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("'-' 只能作为唯一位置参数");
  });

  it('rejects extra attachment paths that are real files before rendering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      const b = join(dir, 'b.sql');
      writeFileSync(a, 'a');
      writeFileSync(b, 'b');
      const result = run(['send', '--dry-run', '--files', a, b], undefined, 'REAL BODY');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('额外路径');
      expect(result.stderr).toContain('多个附件请重复写 --files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts repeated --files flags without a positional body collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      const b = join(dir, 'b.sql');
      writeFileSync(a, 'a');
      writeFileSync(b, 'b');
      const result = run(['send', '--dry-run', '--files', a, '--files', b], undefined, 'REAL BODY');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'REAL BODY' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects exact -- before free help', () => {
    const result = run(['send', '--help', '--']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("'--' 分隔符尚未支持");
  });

  it('rejects --version and value-position help deterministically', () => {
    const version = run(['send', '--version']);
    expect(version.status).toBe(2);
    expect(version.stderr).toContain('未知参数 --version');
    const valueHelp = run(['send', '--mention', '--help']);
    expect(valueHelp.status).toBe(2);
    expect(valueHelp.stderr).toContain('--mention 缺少值');
  });

  it('keeps free help winning over unknown flags', () => {
    const result = run(['send', '--version', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('send [content]');
  });

  it('lets attachment-only sends pass preflight with blank stdin, but lone dash still wins', () => {
    const attachmentOnly = run(['send', '--dry-run', '--images', '/tmp/not-used.png'], undefined, '   ');
    expect(attachmentOnly.status).toBe(2);
    expect(attachmentOnly.stderr).toContain('--dry-run: 正文为空');
    expect(attachmentOnly.stderr).not.toContain("'-' 表示从 stdin");

    const dashWithAttachment = run(['send', '--dry-run', '--images', '/tmp/not-used.png', '-'], undefined, '   ');
    expect(dashWithAttachment.status).toBe(2);
    expect(dashWithAttachment.stderr).toContain("'-' 表示从 stdin 读正文");
    expect(dashWithAttachment.stderr).not.toContain('--dry-run: 正文为空');
  });

  it('runs parameter validation before the blank-stdin body check', () => {
    const mode = run(['send', '--dry-run', '--image-mode=SMALL', '-'], undefined, '   ');
    expect(mode.status).toBe(2);
    expect(mode.stderr).toContain('--image-mode 仅支持');
    expect(mode.stderr).not.toContain('stdin 没有内容');

    const kind = run(['send', '--dry-run', '--response-kind=bogus', '-'], undefined, '   ');
    expect(kind.status).toBe(2);
    expect(kind.stderr).toContain('--response-kind 仅支持');
    expect(kind.stderr).not.toContain('stdin 没有内容');
  });

  it('rejects client hand-written riff placeholders', () => {
    const result = run(['send', '--dry-run', '--files', 'riff-upload:0'], undefined, 'REAL BODY');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('riff-upload 占位符');
  });
});

describe('send --remote-runner-outbound mention guard', () => {
  it.each(['--help', ' --help', '-h', '--dry-run'])(
    'rejects a flag-shaped Remote Runner mention value %s before early exits',
    flag => {
      const result = run([
        'send', '--remote-runner-outbound', '--response-kind', 'progress',
        '--mention', flag, 'must not send',
      ]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('mention values must not look like CLI flags');
      expect(classifyRemoteRunnerOutboundHostResult(
        result.status,
        result.stdout,
        result.stderr,
      )).toMatchObject({ outcome: 'rejected', code: 'outbound_rejected' });
    },
  );
});
