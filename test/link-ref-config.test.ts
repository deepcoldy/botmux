import { describe, expect, it } from 'vitest';
import {
  normalizeLinkRefConfig,
  resolveEffectiveLinkRefMode,
} from '../src/services/link-ref-config.js';

describe('LinkRef config', () => {
  it.each([
    [{}, 'disabled'],
    [{ global: { mode: 'observe' } }, 'observe'],
    [{ global: { mode: 'enabled' }, bot: { mode: 'disabled' } }, 'disabled'],
    [{ global: { mode: 'disabled' }, bot: { mode: 'observe' } }, 'observe'],
    [{ global: { mode: 'enabled' }, bot: { mode: 'observe' }, env: { BOTMUX_LINK_REFS_MODE: 'disabled' } }, 'disabled'],
    [{ global: { mode: 'disabled' }, bot: { mode: 'observe' }, env: { BOTMUX_LINK_REFS_MODE: 'enabled' } }, 'enabled'],
  ] as const)('resolves %j to %s', (input, expected) => {
    expect(resolveEffectiveLinkRefMode({ env: {}, ...input })).toBe(expected);
  });

  it('drops malformed modes instead of enabling them', () => {
    expect(normalizeLinkRefConfig({ mode: 'strict' })).toBeUndefined();
    expect(normalizeLinkRefConfig({ mode: true })).toBeUndefined();
  });
});
