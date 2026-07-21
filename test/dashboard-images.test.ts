import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupMaterializedDashboardImages,
  DASHBOARD_IMAGE_MAX_COUNT,
  materializeDashboardImages,
  parseDashboardImageUploads,
} from '../src/core/dashboard-images.js';
import { config } from '../src/config.js';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZVQAAAAASUVORK5CYII=';

describe('parseDashboardImageUploads', () => {
  it('accepts a valid raster image and removes path traversal from its name', () => {
    expect(parseDashboardImageUploads([{
      name: '../../screen FINAL.PNG',
      mimeType: 'IMAGE/PNG',
      dataBase64: PNG_1X1,
    }])).toEqual({
      ok: true,
      images: [{ name: 'screen-FINAL.png', mimeType: 'image/png', dataBase64: PNG_1X1 }],
    });
  });

  it('rejects SVG and MIME/signature mismatches', () => {
    expect(parseDashboardImageUploads([{
      name: 'x.svg', mimeType: 'image/svg+xml', dataBase64: Buffer.from('<svg/>').toString('base64'),
    }])).toMatchObject({ ok: false, error: 'unsupported_image_type' });
    expect(parseDashboardImageUploads([{
      name: 'fake.png', mimeType: 'image/png', dataBase64: Buffer.from('not png').toString('base64'),
    }])).toMatchObject({ ok: false, error: 'invalid_image_data' });
  });

  it('enforces the image count before decoding payloads', () => {
    const tooMany = Array.from({ length: DASHBOARD_IMAGE_MAX_COUNT + 1 }, () => ({}));
    expect(parseDashboardImageUploads(tooMany)).toMatchObject({ ok: false, error: 'too_many_images' });
  });

  it('cleans the exact dashboard materialization directory', () => {
    const previousDataDir = config.session.dataDir;
    config.session.dataDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-images-'));
    try {
      const parsed = parseDashboardImageUploads([{
        name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_1X1,
      }]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const attachments = materializeDashboardImages('cli_app_test', parsed.images);
      const directory = dirname(attachments[0]!.path);
      expect(existsSync(attachments[0]!.path)).toBe(true);

      cleanupMaterializedDashboardImages('cli_app_test', attachments);
      expect(existsSync(directory)).toBe(false);
    } finally {
      config.session.dataDir = previousDataDir;
    }
  });
});
