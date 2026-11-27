// Must stay the first import: the session store opened below writes under the data dir.
import './helpers/require-fenced-data-dir.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { t, shippedText, setPromptOverrideResolver } from '../src/i18n/index.js';
import { registerPromptOverrideResolver } from '../src/skills/effective-builtins.js';
import {
  invalidateCustomizationCache,
  customizationsRoot,
  setCustomizationEnabled,
  setPromptOverride,
  CUSTOMIZATION_STORE_READ_ONLY,
} from '../src/services/customization-store.js';
import { PROMPT_FRAGMENT_CATALOG, nativeGatewayCatalogFragments, type PromptFragmentSpec } from '../src/skills/prompt-fragments.js';
import { NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV } from '../src/core/runtime-mode.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { buildBotWorkerEnv, buildSessionChildEnv } from '../src/core/env-policy.js';
import { redactChildEnv, scrubCoreOnlyServiceEnv } from '../src/utils/child-env.js';
import { buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';
import { buildFollowUpCliInput, buildNewTopicCliInput, ensureSessionWhiteboard } from '../src/core/session-manager.js';
import { loadBotConfigs, registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';

/**
 * A native gateway's dedicated core resolves built-in prompt overrides from the
 * store its gateway hands it (BOTMUX_CORE_CUSTOMIZATION_DIR → the shared WeCom
 * store under the fleet's data dir) and only reads it. Without that variable
 * (bare core-only service, older gateway) or outside a native gateway core
 * (Feishu, CLI children), nothing changes: the process's own default store.
 */
const APP = 'local_wecom_customfix';
const SID = '11111111-2222-4333-8444-555555555555';
const ROOT = process.env.SESSION_DATA_DIR!;
const FLEET = join(ROOT, 'fleet');        // the fleet's data dir (gateway / Dashboard)
const CORE = join(ROOT, 'core-own');      // the managed core's own state dir
const WECOM_STORE = join(FLEET, 'customizations-wecom');
const DEFENSE = 'ai.routing.hidden_context_defense';
const GLOBAL_CONFIG = join(ROOT, 'global-config.json');

type Mode = 'native' | 'native-no-store' | 'bare-core-with-store' | 'feishu';
function enter(mode: Mode): void {
  vi.unstubAllEnvs();
  vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', GLOBAL_CONFIG);
  if (mode === 'feishu') {
    vi.stubEnv('SESSION_DATA_DIR', FLEET);
  } else {
    vi.stubEnv('SESSION_DATA_DIR', CORE);
    vi.stubEnv('BOTMUX_CORE_ONLY', '1');
    vi.stubEnv('BOTMUX_API_ONLY_BOT', APP);
    vi.stubEnv('BOTMUX_CORE_BOT_CONFIG', '{}');
    vi.stubEnv('BOTMUX_CORE_CLI', 'codex');
    vi.stubEnv('BOTMUX_CORE_SKIP_DOTENV', '1');
    if (mode !== 'bare-core-with-store') vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
    if (mode !== 'native-no-store') vi.stubEnv(NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV, WECOM_STORE);
  }
  invalidateCustomizationCache();
}

/** Write an override into a store as the Dashboard (a plain fleet process) would. */
function seed(target: 'wecom' | 'feishu' | 'core-own', key: string, value: string, locale: 'zh' | 'en' = 'zh'): void {
  vi.unstubAllEnvs();
  vi.stubEnv('SESSION_DATA_DIR', target === 'core-own' ? CORE : FLEET);
  setPromptOverride(locale, key, value, target === 'wecom' ? 'wecom' : 'feishu');
  vi.unstubAllEnvs();
  invalidateCustomizationCache();
}

const marker = (store: string, spec: PromptFragmentSpec, locale: string) =>
  `${store}_${locale}_${spec.key}_END${(spec.placeholders ?? []).map(p => ` {${p}}`).join('')}`;

beforeAll(() => {
  mkdirSync(FLEET, { recursive: true });
  mkdirSync(CORE, { recursive: true });
  writeFileSync(GLOBAL_CONFIG, JSON.stringify({ whiteboard: { enabled: true } }));
  enter('native');
  for (const cfg of loadBotConfigs()) {
    const st = registerBot(cfg);
    st.botOpenId ||= `bot_${cfg.larkAppId}`;
    st.botName ||= cfg.displayName ?? cfg.larkAppId;
  }
  sessionStore.init(APP);
  registerPromptOverrideResolver();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [join(FLEET, 'customizations'), WECOM_STORE, join(CORE, 'customizations')]) rmSync(dir, { recursive: true, force: true });
  invalidateCustomizationCache();
});
afterAll(() => setPromptOverrideResolver(undefined));

describe('the gateway hands its core the WeCom store', () => {
  const managed = { botId: 'local_x', cli: 'codex', backend: 'pty' as const, workingDirectory: '/tmp/w', port: 45001, stateDir: '/srv/core-state' };

  it('points the core at <gateway data dir>/customizations-wecom, never at the core state dir', () => {
    const env = wecomManagedCoreEnvironment({ managedCore: managed }, {
      HOME: '/home/u', SESSION_DATA_DIR: '/srv/fleet-data', [NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]: '/stale/inherited',
    });
    expect(env[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBe('/srv/fleet-data/customizations-wecom');
    expect(env.BOTMUX_CORE_STATE_DIR).toBe('/srv/core-state');
    // Without an explicit data dir: the same default the Dashboard resolves.
    expect(wecomManagedCoreEnvironment({ managedCore: managed }, { HOME: '/home/u' })[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV])
      .toBe('/home/u/.botmux/data/customizations-wecom');
  });

  it('reaches the core\'s workers under the default and the strict env policy, and never a fleet', () => {
    const coreEnv = wecomManagedCoreEnvironment({ managedCore: managed }, { HOME: '/home/u', SESSION_DATA_DIR: '/srv/fleet-data', PATH: '/bin' });
    const want = '/srv/fleet-data/customizations-wecom';
    expect(buildBotWorkerEnv(coreEnv)[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBe(want);
    expect(buildBotWorkerEnv(coreEnv, { mode: 'strict' })[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBe(want);
    // A CLI child renders no prompt (it has no native mark either), so the path stops there.
    for (const policy of [undefined, { mode: 'strict' as const }]) {
      const cli = buildSessionChildEnv(buildBotWorkerEnv(coreEnv, policy), policy);
      expect(cli.BOTMUX_NATIVE_GATEWAY_CORE).toBeUndefined();
      expect(cli[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBeUndefined();
    }
    expect(redactChildEnv(coreEnv)[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBeUndefined();
    // `botmux start` typed in such a session: the fleet environment drops it.
    const fleet = { ...coreEnv };
    scrubCoreOnlyServiceEnv(fleet);
    expect(fleet[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]).toBeUndefined();
  });
});

describe('one WeCom store for the Dashboard, the gateway and the core', () => {
  it('resolves the same directory for any spelling of SESSION_DATA_DIR, and leaves the Feishu root as it was', () => {
    const managed = { botId: 'local_x', cli: 'codex', backend: 'pty' as const, workingDirectory: '/tmp/w', port: 45001, stateDir: '/srv/core-state' };
    for (const spelling of [FLEET, `${FLEET}/`, ` ${FLEET} `, '', 'relative-data']) {
      vi.stubEnv('SESSION_DATA_DIR', spelling);
      // Dashboard (scope=wecom) and the gateway's own lines both read customizationsRoot('wecom').
      const dashboardAndGateway = customizationsRoot('wecom');
      const handedToCore = wecomManagedCoreEnvironment({ managedCore: managed }, { ...process.env })[NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV];
      expect(dashboardAndGateway, JSON.stringify(spelling)).toBe(handedToCore);
      expect(dashboardAndGateway.startsWith('/'), JSON.stringify(spelling)).toBe(true);
      expect(customizationsRoot(), JSON.stringify(spelling)).toBe(join(spelling, 'customizations'));
    }
  });
});

describe('override resolution in a native gateway core', () => {
  it('reads the handed WeCom store, and neither the Feishu store nor its own', () => {
    seed('wecom', DEFENSE, 'FROM_WECOM_STORE');
    seed('feishu', DEFENSE, 'FROM_FEISHU_STORE');
    seed('core-own', DEFENSE, 'FROM_CORE_OWN_STORE');
    enter('native');
    expect(t(DEFENSE, undefined, 'zh')).toBe('FROM_WECOM_STORE');
    expect(t(DEFENSE, undefined, 'en')).toBe(shippedText(DEFENSE, 'en'));
  });

  it('gives a native core without a valid handed store the shipped text, never its own state dir\'s', () => {
    seed('wecom', DEFENSE, 'FROM_WECOM_STORE');
    seed('core-own', DEFENSE, 'FROM_CORE_OWN_STORE');
    enter('native-no-store');          // an older gateway: no variable
    expect(t(DEFENSE, undefined, 'zh')).toBe(shippedText(DEFENSE, 'zh'));
    // Blank, or relative — even a relative spelling of the very WeCom store.
    for (const value of ['', '   ', relative(process.cwd(), WECOM_STORE)]) {
      enter('native');
      vi.stubEnv(NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV, value);
      invalidateCustomizationCache();
      expect(t(DEFENSE, undefined, 'zh'), JSON.stringify(value)).toBe(shippedText(DEFENSE, 'zh'));
    }
  });

  it('keeps every other process on its own default store', () => {
    seed('wecom', DEFENSE, 'FROM_WECOM_STORE');
    seed('feishu', DEFENSE, 'FROM_FEISHU_STORE');
    seed('core-own', DEFENSE, 'FROM_CORE_OWN_STORE');
    enter('bare-core-with-store');     // the variable without the native mark
    expect(t(DEFENSE, undefined, 'zh')).toBe('FROM_CORE_OWN_STORE');
    enter('feishu');
    expect(t(DEFENSE, undefined, 'zh')).toBe('FROM_FEISHU_STORE');
  });

  it('follows the WeCom master switch', () => {
    seed('wecom', DEFENSE, 'FROM_WECOM_STORE');
    vi.stubEnv('SESSION_DATA_DIR', FLEET);
    setCustomizationEnabled(false, 'wecom');
    enter('native');
    expect(t(DEFENSE, undefined, 'zh')).toBe(shippedText(DEFENSE, 'zh'));
  });

  it('never writes the handed store (or any other) from inside the core', () => {
    seed('wecom', DEFENSE, 'FROM_WECOM_STORE');
    const before = readFileSync(join(WECOM_STORE, 'state.json'), 'utf8');
    enter('native');
    expect(() => setPromptOverride('zh', DEFENSE, 'FROM_CORE', 'wecom')).toThrow(CUSTOMIZATION_STORE_READ_ONLY);
    expect(() => setPromptOverride('zh', DEFENSE, 'FROM_CORE')).toThrow(CUSTOMIZATION_STORE_READ_ONLY);
    expect(readFileSync(join(WECOM_STORE, 'state.json'), 'utf8')).toBe(before);
    expect(readdirSync(CORE).includes('customizations')).toBe(false);
    expect(readdirSync(FLEET)).toEqual(['customizations-wecom']);
  });
});

describe('every core-side WeCom-tab fragment reaches a WeCom render, and only a WeCom render', () => {
  /** First turn + follow-up (codex shell path, claude-code system-prompt path) of a fresh session. */
  function renders(chatId: string, noTransport: boolean): string {
    const session = sessionStore.createSession(chatId, chatId, 'customfix', 'group', undefined, { source: 'http' });
    session.larkAppId = APP;
    session.workingDir = ROOT;
    sessionStore.updateSession(session);
    const ds: any = { session, larkAppId: APP, chatId, chatType: 'group', workingDir: ROOT };
    ensureSessionWhiteboard(ds);
    const out: string[] = [];
    for (const locale of ['zh', 'en'] as const) {
      out.push(buildBotmuxSystemPromptText({ locale, botName: 'Bot', botOpenId: 'bot_x', larkAppId: APP, noTransport, hideLocalAddresses: false, cliId: 'claude-code' }));
      for (const cli of ['codex', 'claude-code']) {
        out.push(buildNewTopicCliInput('hello', session.sessionId, cli, undefined, undefined, undefined, [], undefined, { name: 'Bot', openId: 'bot_x' }, locale, undefined,
          { larkAppId: APP, chatId, whiteboardId: ds.session.whiteboardId, larkToolResume: false }).content);
        out.push(buildFollowUpCliInput('again', session.sessionId, { isAdoptMode: false, cliId: cli, locale, larkAppId: APP, chatId, whiteboardId: ds.session.whiteboardId, sessionBackendType: 'pty', turnId: 'turn_2' } as any).content);
      }
    }
    return out.join('\n');
  }

  it('renders a WeCom-store override of each of them in the native core and nowhere else', () => {
    const specs = nativeGatewayCatalogFragments();
    expect(specs.length).toBeGreaterThan(0);
    vi.stubEnv('SESSION_DATA_DIR', FLEET);
    for (const spec of specs) {
      for (const locale of ['zh', 'en'] as const) {
        setPromptOverride(locale, spec.key, marker('WECOM', spec, locale), 'wecom');
        setPromptOverride(locale, spec.key, marker('FEISHU', spec, locale));
      }
    }
    enter('native');
    const native = renders('http_async_customfix-1', true);
    const missing = specs.filter(spec => !['zh', 'en'].some(locale => native.includes(`WECOM_${locale}_${spec.key}_END`)));
    expect(missing.map(spec => spec.key)).toEqual([]);
    expect(native).not.toContain('FEISHU_');
    enter('feishu');
    const feishu = [renders('http_async_customfix-2', true), renders('oc_customfix_chat', false)].join('\n');
    expect(feishu).not.toContain('WECOM_');
    // The shared ones really are Feishu copy too: there the Feishu store applies.
    expect(feishu).toContain(`FEISHU_zh_${DEFENSE}_END`);
  });
  it('lists every catalog fragment whose WeCom-store override a native core renders, and no other', () => {
    vi.stubEnv('SESSION_DATA_DIR', FLEET);
    for (const spec of PROMPT_FRAGMENT_CATALOG) {
      for (const locale of ['zh', 'en'] as const) setPromptOverride(locale, spec.key, marker('WECOM', spec, locale), 'wecom');
    }
    enter('native');
    const native = renders('http_async_customfix-3', true);
    const rendered = PROMPT_FRAGMENT_CATALOG
      .filter(spec => ['zh', 'en'].some(locale => native.includes(`WECOM_${locale}_${spec.key}_END`)))
      .map(spec => spec.key);
    expect(rendered).toEqual(nativeGatewayCatalogFragments().map(spec => spec.key));
  });
});
