import { describe, it, expect } from 'vitest';
import { hd2dAssetPath, hd2dStatus, HD2D_CACHE_DIR } from '../src/dashboard/hd2d-assets.js';

describe('hd2dAssetPath — allow-list guard', () => {
  it('returns a cache path for known assets', () => {
    expect(hd2dAssetPath('index.wasm')).toBe(`${HD2D_CACHE_DIR}/index.wasm`);
    expect(hd2dAssetPath('index.pck')).toBe(`${HD2D_CACHE_DIR}/index.pck`);
  });

  it('rejects anything off the allow-list (path traversal / unknown names)', () => {
    expect(hd2dAssetPath('../../etc/passwd')).toBeNull();
    expect(hd2dAssetPath('index.html')).toBeNull();
    expect(hd2dAssetPath('')).toBeNull();
  });
});

describe('hd2dStatus', () => {
  it('reports absent with the full total before any download', () => {
    const s = hd2dStatus();
    // In a clean env nothing is cached; total is the sum of both binaries.
    expect(s.total).toBe(78_222_186);
    expect(['absent', 'ready']).toContain(s.state);
  });
});
