import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-image-mode-'));
  try {
    return spawnSyncTsScript(cli, args, {
      env: { PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json') },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('send --image-mode', () => {
  it.each([
    ['--image-mode', 'invalid'], ['--image-mode=SMALL'], ['--image-mode'],
    ['--image-mode='], ['--image-mode', 'large'], ['--image-mode=crop_center'], ['--image-mode', '--images', '/tmp/screenshot.png'],
  ])('rejects invalid or missing mode: %j', (...args) => {
    const result = run(['send', ...args]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--image-mode 仅支持');
  });

  it.each(['fit_horizontal', 'medium', 'small', 'tiny'])('accepts %s before attachment validation', mode => {
    // Reject stdin-as-attachment after parsing, without uploading or sending.
    const result = run(['send', `--image-mode=${mode}`, '--images', '-']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('不能把 stdin');
  });

  it('documents the allowed modes and default in help', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--image-mode <mode>');
    expect(result.stdout).toContain('fit_horizontal（默认）|medium|small|tiny');
    expect(result.stdout).toContain('medium/small/tiny 等比占宽 1/2、1/3、1/4');
  });
});


describe('cmdSend outbound card JSON', () => {
  it.each([
    ['medium', 2], ['small', 3], ['tiny', 4], ['fit_horizontal', 0],
  ])('delivers the width preset through the real CLI: %s', (mode, columnCount) => {
    for (const upload of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-image-card-'));
      try {
        const path = join(dir, 'screenshot.png');
        writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));
        const result = spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-image-mode-capture.ts', import.meta.url)), [
          'send', '--image-mode', mode, '--no-mention', '--top-level',
          ...(upload ? ['--images', path, '截图'] : ['![截图](img_v3_test_upload)']),
        ], {
          env: {
            PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json'),
            BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_LARK_APP_SECRET: 'test',
            BOTMUX_SESSION_ID: 'test-image-mode', BOTMUX_CHAT_ID: 'oc_test', BOTMUX_SESSION_SCOPE: 'chat',
          },
          encoding: 'utf8', timeout: 30_000,
        });
        expect(result.status, String(result.stderr)).toBe(0);
        const captured = String(result.stdout).split('\n').find(line => line.startsWith('CAPTURE_CARD='));
        expect(captured, String(result.stdout)).toBeTruthy();
        const card = JSON.parse(captured!.slice('CAPTURE_CARD='.length));
        expect(card.schema).toBe('2.0');
        const row = card.body.elements.find((e: any) => e.tag === 'column_set');
        if (columnCount) {
          expect(row).toMatchObject({ flex_mode: 'none', horizontal_spacing: '0px' });
          expect(row.columns).toHaveLength(columnCount as number);
          for (const column of row.columns) expect(column).toMatchObject({ width: 'weighted', weight: 1 });
          for (const column of row.columns.slice(1)) expect(column.elements).toEqual([]);
          expect(row.columns[0].elements).toEqual([{ tag: 'img', img_key: 'img_v3_test_upload', alt: { tag: 'plain_text', content: upload ? '' : '截图' }, scale_type: 'fit_horizontal', preview: true }]);
          expect(row.columns[0].elements[0]).not.toHaveProperty('mode');
          expect(row.columns[0].elements[0]).not.toHaveProperty('size');
        } else {
          expect(row).toBeUndefined();
          expect(card.body.elements.some((e: any) => e.tag === 'markdown' && e.content.includes('(img_v3_test_upload)'))).toBe(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
