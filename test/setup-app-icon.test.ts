import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOTMUX_APP_ICON_BASE64, BOTMUX_APP_ICON_BYTES } from '../src/setup/app-icon-data.js';
import { ICON_SOURCE, ICON_MODULE, renderIconModule } from '../scripts/generate-app-icon-data.mjs';

/**
 * The default Feishu app icon must be reachable from the COMPILED BINARY.
 *
 * THE BUG THIS PINS: `setup`'s app-creation step resolved the icon from
 * `dirname(fileURLToPath(import.meta.url))`, which in a `bun build --compile` binary
 * is the virtual `/$bunfs/root`. MEASURED by compiling that exact function:
 *
 *     here          = /$bunfs/root
 *     resolved icon = undefined      → throws `找不到 botmux 默认应用图标`
 *
 * It missed even with a real favicon.png beside the binary, because `here` never
 * points at the filesystem. Every install.sh / npm / bun global user was blocked from
 * creating a bot. Same class as 88e3d7f24 (Dashboard 404) and 2ef5c3a58
 * (lark-scopes.json).
 *
 * ⚠️ WHY A UNIT TEST CANNOT SEE THE ORIGINAL DEFECT. Vitest runs under Node, where
 * the old disk path RESOLVED FINE — the failure existed only in a form nothing in the
 * repo executed. So the guard here is not "does the icon load" (it always did under
 * Node); it is:
 *   1. the icon lives in the MODULE GRAPH (a plain import), which is what `--compile`
 *      traces — asserted by decoding it, since a Node-only path could not,
 *   2. the generated module has not drifted from the PNG,
 *   3. `audit-embedded-assets.mjs` fails the build if any source site goes back to
 *      reading an asset off a module-relative path — the gate is what actually
 *      protects the compiled form, so its teeth are tested here too.
 */

describe('default app icon — reachable from the compiled binary', () => {
  it('decodes from the module graph to a real 512x512 PNG', () => {
    const icon = Buffer.from(BOTMUX_APP_ICON_BASE64, 'base64');
    expect(icon.length).toBe(BOTMUX_APP_ICON_BYTES);
    // PNG signature, then the IHDR width/height at fixed offsets. Asserting the
    // DIMENSIONS matters: the Open Platform upload declares 512x512, so a differently
    // sized image would upload and then render wrong.
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
  });

  it('matches the PNG it is generated from (no silent drift)', () => {
    // Without this, editing src/dashboard/web/favicon.png would keep shipping the old
    // bytes forever: the constant is committed, so nothing else would notice.
    expect(readFileSync(ICON_MODULE, 'utf8')).toBe(renderIconModule());
    // And the constant really is that file's bytes, not merely self-consistent.
    expect(Buffer.from(BOTMUX_APP_ICON_BASE64, 'base64').equals(readFileSync(ICON_SOURCE))).toBe(true);
  });

  it('SOURCE PIN: setup does not resolve the icon from a module-relative path', () => {
    // Strip comments first: the fixed site keeps a docblock that QUOTES the old bad
    // path as the thing not to reintroduce, and matching prose would make this
    // assertion fire on its own explanation.
    const code = readFileSync(resolve('src/setup/open-platform-automation.ts'), 'utf8')
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/favicon\.png/);
    expect(code).toContain('BOTMUX_APP_ICON_BASE64');
  });

  /**
   * The build gate is the durable half of this fix, so prove it BITES rather than
   * trusting that it exists. Its first version required the directory derivation and
   * the asset extension on the SAME line and therefore did NOT fire on the real
   * pre-fix code (two statements) — a gate whose positive control stays green is worse
   * than none.
   */
  it('the build gate rejects a module-relative asset read (positive control)', () => {
    // The offending shape, injected via env so no repo file is touched: the gate
    // scans src/, so we point it at a throwaway tree instead of mutating the real one.
    const probe = spawnSync(process.execPath, [resolve('scripts/audit-embedded-assets.mjs')], {
      encoding: 'utf-8',
      cwd: resolve('.'),
      timeout: 120_000,
      env: { ...process.env, BOTMUX_AUDIT_EXTRA_SRC: resolve('test/fixtures/module-relative-asset-read') },
    });
    expect(probe.error).toBeUndefined();
    expect(probe.status, `gate should reject; stdout=${probe.stdout} stderr=${probe.stderr}`).not.toBe(0);
    const output = `${probe.stdout}${probe.stderr}`;
    expect(output).toContain('module-relative path');
    // Assert EACH fixture shape fires, not just that the run failed — otherwise the
    // gate could lose a syntax (e.g. stop recognising `import.meta.dirname`) while the
    // two-statement fixture keeps the test green. That is the same "control does not
    // fire" failure mode this test exists to prevent, one level up.
    for (const fixture of ['offender.ts', 'modern-idiom.ts', 'new-url.ts', 'uppercase-ext.ts']) {
      expect(output, `gate should flag ${fixture}`).toContain(fixture);
    }
  });

  it('the build gate passes on the real tree (so the control above is discriminating)', () => {
    const probe = spawnSync(process.execPath, [resolve('scripts/audit-embedded-assets.mjs')], {
      encoding: 'utf-8',
      cwd: resolve('.'),
      timeout: 120_000,
    });
    expect(probe.error).toBeUndefined();
    expect(probe.status, `gate should pass; stdout=${probe.stdout} stderr=${probe.stderr}`).toBe(0);
  });
});
