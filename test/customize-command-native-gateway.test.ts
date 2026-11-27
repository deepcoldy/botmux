// Must stay the first import: the CLI runs below write under the fenced data dir.
import './helpers/require-fenced-data-dir.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { NATIVE_GATEWAY_DATA_DIR_MARK } from '../src/core/native-gateway-session.js';
import { wecomManagedCoreEnvironment } from '../src/im/wecom/config/managed-core-env.js';
import { buildBotWorkerEnv, buildSessionChildEnv } from '../src/core/env-policy.js';
import { BOTMUX_INJECTED_ENV_KEYS, pinCoreOnlyServiceDataDir } from '../src/utils/child-env.js';
import { isNativeGatewayCoreEnv } from '../src/core/runtime-mode.js';
import { inNativeGatewaySession, syncNativeGatewayDataDirMark } from '../src/core/native-gateway-session.js';
import { WECOM_SESSION_CUSTOMIZE_REFUSAL, feishuStoreKeyRejection } from '../src/im/wecom/contract/customization.js';

/**
 * `botmux customize` typed in a WeCom session's shell. The store it would use
 * there is the managed core's own state dir, which nothing renders from (the
 * core reads the WeCom store its gateway hands it), so every subcommand refuses
 * with a pointer to the Dashboard and writes nothing — on the PTY backend (the
 * core's env minus what the CLI boundary drops) and in a tmux/zellij pane (only
 * the injected keys). A Feishu session and a bare core-only service's session
 * behave exactly as before. The environments are built the way the real chain
 * builds them: gateway → wecomManagedCoreEnvironment → index-core-only.ts
 * (pin + mark) → worker → CLI boundary.
 */
const ROOT = process.env.SESSION_DATA_DIR!;
let dir: string;
let fleet: string;
let home: string;

beforeAll(() => {
  dir = mkdtempSync(join(ROOT, 'customize-native-'));
  fleet = join(dir, 'fleet');
  home = join(dir, 'home');
  for (const d of [fleet, home]) mkdirSync(d, { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The env a CLI child of a managed core gets, PTY backend; `native` = a WeCom gateway's core. */
function coreSessionEnv(core: string, native: boolean): NodeJS.ProcessEnv {
  mkdirSync(core, { recursive: true });
  const gatewayEnv = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
  const coreEnv = wecomManagedCoreEnvironment({ managedCore: { botId: 'local_cz', cli: 'codex', backend: 'pty', workingDirectory: dir, port: 45003, stateDir: core } }, gatewayEnv);
  if (!native) delete coreEnv.BOTMUX_NATIVE_GATEWAY_CORE;       // a bare core-only service
  pinCoreOnlyServiceDataDir(coreEnv, core);                     // index-core-only.ts
  syncNativeGatewayDataDirMark(core, isNativeGatewayCoreEnv(coreEnv));
  return buildSessionChildEnv(buildBotWorkerEnv(coreEnv));
}

/** The same session as a tmux/zellij pane sees it: only the injected keys survive. */
function paneEnv(cli: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: cli.PATH, HOME: cli.HOME, BOTMUX_FENCED_RUN: cli.BOTMUX_FENCED_RUN };
  for (const key of BOTMUX_INJECTED_ENV_KEYS) if (cli[key] !== undefined) out[key] = cli[key];
  return out;
}

function customize(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const r = spawnSyncTsScript('src/cli.ts', ['customize', ...args], { env, encoding: 'utf8', timeout: 90_000, ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

/** Boot the real core-only entry with `env`; an invalid port makes it exit right after pinning and marking its store. */
function bootCoreEntry(env: NodeJS.ProcessEnv): string {
  const r = spawnSyncTsScript('src/index-core-only.ts', [], { env: { ...env, BOTMUX_API_PORT: 'invalid' }, encoding: 'utf8', timeout: 60_000 });
  return String(r.stderr);
}

const storedOverrides = (d: string) => JSON.parse(readFileSync(join(d, 'customizations', 'state.json'), 'utf8')).promptOverrides;
const files = (d: string) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).filter(f => f.startsWith('customizations')).sort() : []);
const BUNDLE = JSON.stringify({ schemaVersion: 1, kind: 'botmux-customization-bundle', promptOverrides: { zh: { 'ai.routing.intro': 'IMPORTED' } } });

describe('botmux customize inside a WeCom session', () => {
  it('refuses every subcommand with the Dashboard pointer, on PTY and in a pane, and writes nothing', () => {
    const core = join(dir, 'wecom-core');
    const pty = coreSessionEnv(core, true);
    expect(inNativeGatewaySession(pty)).toBe(true);
    const bundleFile = join(dir, 'bundle.json');
    writeFileSync(bundleFile, BUNDLE);
    const subcommands = [
      ['prompt', 'set', 'ai.routing.hidden_context_defense', 'FROM_WECOM_SESSION'],
      ['status'],
      ['prompt', 'show', 'ai.routing.hidden_context_defense'],
      ['import', bundleFile, '--yes'],
    ];
    for (const env of [pty, paneEnv(pty), { ...pty, SESSION_DATA_DIR: fleet }]) {
      for (const args of subcommands) {
        const r = customize(args, env);
        expect(r.code, args.join(' ')).not.toBe(0);
        expect(r.err, args.join(' ')).toContain(WECOM_SESSION_CUSTOMIZE_REFUSAL);
        expect(r.out, args.join(' ')).toBe('');
      }
    }
    expect(files(core)).toEqual([]);
    expect(files(fleet)).toEqual([]);
  }, 600_000);

  it('leaves a bare core-only service\'s session writing its own store, as before', () => {
    const core = join(dir, 'bare-core');
    // A stale mark from an earlier native life of the same dir is cleared on boot.
    mkdirSync(core, { recursive: true });
    syncNativeGatewayDataDirMark(core, true);
    const env = coreSessionEnv(core, false);
    expect(inNativeGatewaySession(env)).toBe(false);
    const r = customize(['prompt', 'set', 'ai.routing.hidden_context_defense', 'FROM_BARE_CORE'], env);
    expect(r.code).toBe(0);
    expect(files(core)).toContain('customizations/state.json');
    expect(storedOverrides(core)).toMatchObject({ zh: { 'ai.routing.hidden_context_defense': 'FROM_BARE_CORE' } });
  }, 120_000);

  it('leaves a Feishu session as before, except that a WeCom export no longer imports there', () => {
    const env = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    expect(inNativeGatewaySession(env)).toBe(false);
    const set = customize(['prompt', 'set', 'ai.routing.intro', 'FROM_FEISHU'], env);
    expect(set.code).toBe(0);
    expect(storedOverrides(fleet)).toMatchObject({ zh: { 'ai.routing.intro': 'FROM_FEISHU' } });
    const wecomExport = JSON.stringify({ schemaVersion: 1, kind: 'botmux-customization-bundle', scope: 'wecom', promptOverrides: { zh: { 'wecom.task.channel_group': 'W' } } });
    const refused = customize(['import', '-', '--yes'], env, wecomExport);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('企业微信');
    const accepted = customize(['import', '-', '--yes'], env, BUNDLE);
    expect(accepted.code).toBe(0);
  }, 180_000);

  it('is marked by the real core entry for a native gateway core only, and cleared for a bare one', () => {
    const gatewayEnv = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    const boot = (state: string, native: boolean) => {
      const env = wecomManagedCoreEnvironment({ managedCore: { botId: 'local_cz_entry', cli: 'codex', backend: 'pty', workingDirectory: dir, port: 45004, stateDir: state } }, gatewayEnv);
      if (!native) delete env.BOTMUX_NATIVE_GATEWAY_CORE;
      // An invalid port: the entry pins and marks its store, then exits at its own port check.
      const r = spawnSyncTsScript('src/index-core-only.ts', [], { env: { ...env, BOTMUX_API_PORT: 'invalid' }, encoding: 'utf8', timeout: 60_000 });
      expect(String(r.stderr)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
      return existsSync(join(state, NATIVE_GATEWAY_DATA_DIR_MARK));
    };
    const state = join(dir, 'entry-state');
    expect(boot(state, true)).toBe(true);
    expect(boot(state, false)).toBe(false);
  }, 120_000);

  it('keeps refusing in a WeCom session after a bare core-only service is started from inside it', () => {
    const state = join(dir, 'nested-from-session');
    const gatewayEnv = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    const native = wecomManagedCoreEnvironment({ managedCore: { botId: 'local_cz_nested', cli: 'codex', backend: 'pty', workingDirectory: dir, port: 45005, stateDir: state } }, gatewayEnv);
    expect(bootCoreEntry(native)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
    const coreProcess = { ...native };
    pinCoreOnlyServiceDataDir(coreProcess, state);                // index-core-only.ts
    const session = buildSessionChildEnv(buildBotWorkerEnv(coreProcess));
    expect(inNativeGatewaySession(session)).toBe(true);
    // `botmux serve --api-only` typed in that session (src/cli.ts cmdServe): its env, core-only, no SESSION_DATA_DIR.
    const serve: NodeJS.ProcessEnv = { ...session, BOTMUX_CORE_ONLY: '1', BOTMUX_WORKER_HTTP_HOST: '127.0.0.1' };
    delete serve.SESSION_DATA_DIR;
    expect(bootCoreEntry(serve)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
    expect(inNativeGatewaySession(session)).toBe(true);
    const r = customize(['prompt', 'set', 'ai.routing.hidden_context_defense', 'AFTER_NESTED_SERVE'], session);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(WECOM_SESSION_CUSTOMIZE_REFUSAL);
    expect(files(state)).toEqual([]);
  }, 180_000);

  it('keeps the mark when the nested bare core names the session\'s own dir differently (symlink, trailing slash, ..)', () => {
    const gatewayEnv = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    const real = join(dir, 'spelled-store');
    const link = join(dir, 'spelled-store-link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    // A native core whose store is spelled through the symlink (resolve() keeps symlinks).
    const native = wecomManagedCoreEnvironment({ managedCore: { botId: 'local_cz_spelled', cli: 'codex', backend: 'pty', workingDirectory: dir, port: 45007, stateDir: link } }, gatewayEnv);
    expect(bootCoreEntry(native)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
    const coreProcess = { ...native };
    pinCoreOnlyServiceDataDir(coreProcess, link);                 // index-core-only.ts
    const session = buildSessionChildEnv(buildBotWorkerEnv(coreProcess));
    expect(session.BOTMUX_CORE_ONLY_DATA_DIR).toBe(link);
    expect(inNativeGatewaySession(session)).toBe(true);
    // `botmux serve --api-only --state-dir <the same dir, spelled otherwise>` typed in that session.
    for (const spelling of [real, `${real}/`, `${real}/../${basename(real)}`, `${link}/`]) {
      const serve: NodeJS.ProcessEnv = { ...session, BOTMUX_CORE_ONLY: '1', BOTMUX_WORKER_HTTP_HOST: '127.0.0.1', BOTMUX_CORE_STATE_DIR: spelling };
      delete serve.SESSION_DATA_DIR;
      expect(bootCoreEntry(serve)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
      expect(existsSync(join(real, NATIVE_GATEWAY_DATA_DIR_MARK)), spelling).toBe(true);
      expect(inNativeGatewaySession(session), spelling).toBe(true);
    }
  }, 180_000);

  it('clears a stale mark on another dir when a bare core is started from inside a WeCom session with --state-dir', () => {
    const gatewayEnv = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: fleet, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    const nativeOn = (state: string, botId: string) => wecomManagedCoreEnvironment({ managedCore: { botId, cli: 'codex', backend: 'pty', workingDirectory: dir, port: 45006, stateDir: state } }, gatewayEnv);
    const sessionOf = (env: NodeJS.ProcessEnv, state: string) => {
      const coreProcess = { ...env };
      pinCoreOnlyServiceDataDir(coreProcess, state);            // index-core-only.ts
      return buildSessionChildEnv(buildBotWorkerEnv(coreProcess));
    };
    const live = join(dir, 'live-connection');
    const stale = join(dir, 'stale-elsewhere');
    expect(bootCoreEntry(nativeOn(live, 'local_cz_live'))).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
    expect(bootCoreEntry(nativeOn(stale, 'local_cz_stale'))).toMatch(/\[core-only\].*BOTMUX_API_PORT/);  // an earlier connection's mark
    const session = sessionOf(nativeOn(live, 'local_cz_live'), live);
    expect(inNativeGatewaySession(session)).toBe(true);
    // `botmux serve --api-only --state-dir <stale>` typed in the live connection's session.
    const serve: NodeJS.ProcessEnv = { ...session, BOTMUX_CORE_ONLY: '1', BOTMUX_WORKER_HTTP_HOST: '127.0.0.1', BOTMUX_CORE_STATE_DIR: stale };
    delete serve.SESSION_DATA_DIR;
    expect(bootCoreEntry(serve)).toMatch(/\[core-only\].*BOTMUX_API_PORT/);
    // The other dir is cleared exactly as from a plain shell; the live connection keeps its own.
    expect(existsSync(join(stale, NATIVE_GATEWAY_DATA_DIR_MARK))).toBe(false);
    expect(inNativeGatewaySession(sessionOf(serve, stale))).toBe(false);
    expect(inNativeGatewaySession(session)).toBe(true);
  }, 180_000);

  it('refuses to set a WeCom-only key in the Feishu store from a Feishu shell, and still removes one', () => {
    const data = join(dir, 'feishu-wecom-key');
    mkdirSync(data, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home, SESSION_DATA_DIR: data, BOTMUX_FENCED_RUN: process.env.BOTMUX_FENCED_RUN };
    for (const args of [['prompt', 'set', 'wecom.task.channel_group', 'X'], ['condition', 'wecom.task.channel_group', 'on']]) {
      const r = customize(args, env);
      expect([r.code, r.out], args.join(' ')).toEqual([2, '']);
      expect(r.err, args.join(' ')).toContain(feishuStoreKeyRejection('wecom.task.channel_group')!);
    }
    expect(files(data)).toEqual([]);
    // Removing such a key (data from before this rule) stays possible.
    for (const args of [['prompt', 'reset', 'wecom.task.channel_group'], ['condition', 'wecom.task.channel_group', 'reset']]) {
      expect(customize(args, env).code, args.join(' ')).toBe(0);
    }
  }, 180_000);
});
