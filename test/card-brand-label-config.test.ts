import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath } from '../src/global-config.js';
import { config } from '../src/config.js';
import {
  isCardBrandLabelEnabled,
  registerBot,
  resolveBrandLabel,
} from '../src/bot-registry.js';
import { brandFooterSegment, DEFAULT_BRAND_LABEL } from '../src/im/lark/md-card.js';

/**
 * Machine-wide footer-brand switch: `~/.botmux/config.json` →
 * `dashboard.cardBrandLabel`, DEFAULT ON. An explicit `false` makes
 * resolveBrandLabel() — the single choke point every reply-card builder feeds
 * (cli.ts `botmux send`, worker-pool daemon cards) — return '' for EVERY bot,
 * so brandFooterSegment drops the brand instead of falling back to the default
 * botmux link. Sandboxed one-shot children can't read config.json (EPERM), so
 * the worker bridges the value as BOTMUX_CARD_BRAND_ENABLED (own-appId gated).
 */
describe('cardBrandLabel — global footer-brand switch', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-card-brand-'));
    vi.stubEnv('HOME', home);
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function writeDashboard(dashboard: Record<string, unknown>): void {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard }));
  }

  function registerCustomBot(appId: string, brandLabel: string) {
    registerBot({
      larkAppId: appId,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      brandLabel,
    } as any);
  }

  describe('config.cardBrandLabelEnabled getter (default ON)', () => {
    it('is ON with no config file', () => {
      expect(config.cardBrandLabelEnabled).toBe(true);
    });

    it('is ON when the dashboard block/key is absent', () => {
      writeDashboard({ codexRpcInput: true });
      expect(config.cardBrandLabelEnabled).toBe(true);
    });

    it('is ON when explicitly true', () => {
      writeDashboard({ cardBrandLabel: true });
      expect(config.cardBrandLabelEnabled).toBe(true);
    });

    it('is OFF only when explicitly persisted false', () => {
      writeDashboard({ cardBrandLabel: false });
      expect(config.cardBrandLabelEnabled).toBe(false);
    });

    it('ignores a non-boolean value and stays ON', () => {
      writeDashboard({ cardBrandLabel: 'off' });
      expect(config.cardBrandLabelEnabled).toBe(true);
    });
  });

  describe('resolveBrandLabel applies the switch at the choke point', () => {
    it('switch ON (default): a registered custom label is returned', () => {
      registerCustomBot('app_custom_on', '[Acme](https://acme.test)');
      expect(resolveBrandLabel('app_custom_on')).toBe('[Acme](https://acme.test)');
    });

    it('switch ON (default): an unset bot stays undefined (→ default link downstream)', () => {
      expect(resolveBrandLabel('app_unset_on')).toBeUndefined();
      expect(brandFooterSegment(resolveBrandLabel('app_unset_on'))).toBe(DEFAULT_BRAND_LABEL);
    });

    it('switch OFF: a registered CUSTOM label is suppressed as "" (not returned, not defaulted)', () => {
      writeDashboard({ cardBrandLabel: false });
      registerCustomBot('app_custom_off', '[Acme](https://acme.test)');
      const resolved = resolveBrandLabel('app_custom_off');
      expect(resolved).toBe('');
      // The "" must reach the footer builder as suppression, NOT fall through to
      // the default botmux link — that distinction is the whole feature.
      expect(brandFooterSegment(resolved)).toBeNull();
    });

    it('switch OFF: an UNSET bot also resolves "" so the default link is suppressed', () => {
      writeDashboard({ cardBrandLabel: false });
      const resolved = resolveBrandLabel('app_unset_off');
      expect(resolved).toBe('');
      expect(brandFooterSegment(resolved)).toBeNull();
    });

    it('switch explicit true: custom label passes and unset stays undefined', () => {
      writeDashboard({ cardBrandLabel: true });
      registerCustomBot('app_custom_true', '[Acme](https://acme.test)');
      expect(resolveBrandLabel('app_custom_true')).toBe('[Acme](https://acme.test)');
      expect(resolveBrandLabel('app_unset_true')).toBeUndefined();
    });

    it('garbage stored value: behaves as ON', () => {
      writeDashboard({ cardBrandLabel: 0 });
      registerCustomBot('app_custom_garbage', '[Acme](https://acme.test)');
      expect(resolveBrandLabel('app_custom_garbage')).toBe('[Acme](https://acme.test)');
    });
  });

  describe('sandbox child env bridge (BOTMUX_CARD_BRAND_ENABLED)', () => {
    it('own-appId + "false" suppresses even an env-injected custom label', () => {
      // Simulate the worker spawn env for a sandboxed `botmux send` that cannot
      // read config.json (HOME here has no dashboard key → config reads enabled).
      vi.stubEnv('BOTMUX_LARK_APP_ID', 'app_child');
      vi.stubEnv('BOTMUX_CARD_BRAND_ENABLED', 'false');
      vi.stubEnv('BOTMUX_BRAND_LABEL', '[Acme](https://acme.test)');
      expect(isCardBrandLabelEnabled('app_child')).toBe(false);
      expect(resolveBrandLabel('app_child')).toBe('');
      expect(brandFooterSegment(resolveBrandLabel('app_child'))).toBeNull();
    });

    it('own-appId + "true" honours the injected brand label', () => {
      vi.stubEnv('BOTMUX_LARK_APP_ID', 'app_child');
      vi.stubEnv('BOTMUX_CARD_BRAND_ENABLED', 'true');
      vi.stubEnv('BOTMUX_BRAND_LABEL', '[Acme](https://acme.test)');
      expect(isCardBrandLabelEnabled('app_child')).toBe(true);
      expect(resolveBrandLabel('app_child')).toBe('[Acme](https://acme.test)');
    });

    it('a "false" bridged for a DIFFERENT appId is ignored (no cross-bot bleed)', () => {
      vi.stubEnv('BOTMUX_LARK_APP_ID', 'app_self');
      vi.stubEnv('BOTMUX_CARD_BRAND_ENABLED', 'false');
      // No config file in HOME → enabled; the sibling env value must not bleed.
      expect(isCardBrandLabelEnabled('app_other')).toBe(true);
      expect(resolveBrandLabel('app_other')).toBeUndefined();
    });

    it('a non-"false" bridged value is treated as enabled', () => {
      vi.stubEnv('BOTMUX_LARK_APP_ID', 'app_child');
      vi.stubEnv('BOTMUX_CARD_BRAND_ENABLED', '');
      expect(isCardBrandLabelEnabled('app_child')).toBe(true);
    });
  });
});
