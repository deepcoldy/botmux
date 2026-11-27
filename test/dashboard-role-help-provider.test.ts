import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_PROFILE_SHARED_PARTS } from '../src/dashboard/web/bot-defaults-page.js';
import { createDashboardTranslator, type DashboardLocale } from '../src/dashboard/web/i18n.js';
import { botProfileCapabilities, botProfileSectionProps } from '../src/dashboard/web/providers/profile.js';
import { ui } from '../src/dashboard/web/ui.js';
import { BotProfileRequestContext } from '../src/dashboard/web/wecom-bot-config.js';

/**
 * The 「默认角色」 section is one shared component on the Feishu and the WeCom bot
 * page. Its two help texts describe where the role applies and when 「仅一次」 injects
 * it; that differs on WeCom (no per-chat override, a new session per /restart), so
 * a WeCom bot gets its own texts while a Feishu bot keeps the ones it always had.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: TestRenderer.ReactTestRenderer | undefined;
const previousLocale = ui.locale;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  ui.setLocale(previousLocale);
  vi.unstubAllGlobals();
});

const FEISHU_BOT = { larkAppId: 'cli_fakerolehelp', teamRole: 'fake role' };
const WECOM_BOT = { larkAppId: '', provider: 'wecom', providerBotId: 'conn-fake', teamRole: 'fake role' };

/** Help props of the section title and of the inject-mode title, as rendered. */
async function roleHelp(bot: Record<string, unknown>, kind: 'lark' | 'wecom', locale: DashboardLocale) {
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
  vi.stubGlobal('document', { documentElement: { dataset: {} }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ profiles: [] }) }));
  ui.setLocale(locale);
  const tr = createDashboardTranslator(locale);
  const request = async () => ({ ok: true, status: 200, body: { ok: true, role: 'fake role', injectMode: 'every' } });
  const { RoleSection } = BOT_PROFILE_SHARED_PARTS;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(
      BotProfileRequestContext.Provider, { value: request as any },
      React.createElement(RoleSection, { ...botProfileSectionProps(botProfileCapabilities(kind)).role, bot: bot as any, patchBot: () => {} }),
    ));
  });
  // The page's field titles: a label (children) with its help text (help prop).
  const titles = renderer!.root.findAll(node => typeof node.type !== 'string' && 'help' in node.props && typeof node.props.children === 'string');
  const helpOf = (labelKey: string) => {
    const matching = titles.filter(node => node.props.children === tr(labelKey));
    expect(matching, labelKey).toHaveLength(1);
    return matching[0]!.props.help as string;
  };
  return { tr, section: helpOf('botDefaults.sectionRole'), injectMode: helpOf('roles.injectModeLabel') };
}

describe.each(['zh', 'en'] as const)('default role help texts (%s)', locale => {
  it('a Feishu bot keeps the texts it always showed', async () => {
    const { tr, section, injectMode } = await roleHelp(FEISHU_BOT, 'lark', locale);
    expect(section).toBe(tr('botDefaults.roleHelp'));
    expect(injectMode).toBe(tr('roles.injectModeHint'));
  });

  it('a WeCom bot gets its own texts', async () => {
    const { tr, section, injectMode } = await roleHelp(WECOM_BOT, 'wecom', locale);
    expect(section).toBe(tr('botDefaults.wecom.roleHelp'));
    expect(injectMode).toBe(tr('botDefaults.wecom.roleInjectModeHint'));
    // A real translation in this locale, not the Feishu text and not a missing key echoed back.
    expect(section).not.toBe(tr('botDefaults.roleHelp'));
    expect(injectMode).not.toBe(tr('roles.injectModeHint'));
    expect(section).not.toBe('botDefaults.wecom.roleHelp');
    expect(injectMode).not.toBe('botDefaults.wecom.roleInjectModeHint');
  });
});
