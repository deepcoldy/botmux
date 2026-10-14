import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome } from '../src/core/working-dir.js';
import { expandHomePath } from '../src/utils/working-dir.js';
import { codexHome } from '../src/services/codex-paths.js';
import { opencodeDataRoot } from '../src/services/opencode-paths.js';
import { traeHome } from '../src/services/traex-paths.js';
import * as mimocodePaths from '../src/services/mimocode-paths.js';

// Six verbatim copies of this one-liner existed (core/working-dir, utils/working-dir,
// and the codex / opencode / traex / mimocode path modules). It deliberately
// treats `~user` like `~/user` — that quirk is preserved, not fixed.
const oldExpand = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const CORPUS = [
  '', '~', '~/', '~/x', '~/x/y/', '~x', '~root/x', '~~', '~/~', '/abs/~', 'rel/~/x', ' ~', '~ ', '~\\x', '~//x', '~/..', '~/../etc',
  '.', './x', '/', '/tmp/x', 'C:\\x', '中文/~', '~/中文',
];

describe('expandHome consolidation', () => {
  it('core/working-dir.expandHome and utils/working-dir.expandHomePath are the one function with the old results', () => {
    for (const p of CORPUS) {
      expect(expandHomePath(p), JSON.stringify(p)).toBe(oldExpand(p));
      expect(expandHome(p), JSON.stringify(p)).toBe(expandHomePath(p));
    }
  });

  describe('path modules resolve a tilde env override the same way', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of ['CODEX_HOME', 'XDG_DATA_HOME', 'TRAE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    });

    it('CODEX_HOME / TRAE_HOME / XDG_DATA_HOME', () => {
      for (const value of ['~/botmux-x', '~', '~weird', '/abs/path']) {
        process.env.CODEX_HOME = value;
        process.env.TRAE_HOME = value;
        process.env.XDG_DATA_HOME = value;
        expect(codexHome(), value).toBe(oldExpand(value));
        expect(traeHome(), value).toBe(oldExpand(value));
        expect(opencodeDataRoot(), value).toBe(join(oldExpand(value), 'opencode'));
      }
    });

    it('mimocode XDG roots expand a tilde override (and keep the literal ~ display fallback when unset)', () => {
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) process.env[key] = '~/mimo-x';
      expect(mimocodePaths.mimocodeDataRoot()).toBe(join(oldExpand('~/mimo-x'), 'mimocode'));
      expect(mimocodePaths.mimocodeConfigPath()).toBe(join(oldExpand('~/mimo-x'), 'mimocode'));
      expect(mimocodePaths.mimocodeDataPath()).toBe(join(oldExpand('~/mimo-x'), 'mimocode'));
      expect(mimocodePaths.mimocodeStatePath()).toBe(join(oldExpand('~/mimo-x'), 'mimocode'));
      expect(mimocodePaths.mimocodeCachePath()).toBe(join(oldExpand('~/mimo-x'), 'mimocode'));
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete process.env[key];
      expect(mimocodePaths.mimocodeConfigPath()).toBe('~/.config/mimocode');
      expect(mimocodePaths.mimocodeDataRoot()).toBe(join(homedir(), '.local/share', 'mimocode'));
    });
  });
});
