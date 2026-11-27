import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
import { resolveDashboardIdentity } from '../src/dashboard/request-identity.js';
import { DashboardSessionStore } from '../src/dashboard/h5-auth.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-profile-probes-')); roots.push(root);
  const log = join(root, 'probes.jsonl'), bin = join(root, 'probe.cjs');
  writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs');const source=process.env.PROBE_SOURCE;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({source,args:process.argv.slice(2),gateway:!!process.env.STRANGE_TRANSPORT_CREDENTIAL,wecom:!!process.env.WECOM_BOT_SECRET,internal:Object.keys(process.env).filter(key=>key.startsWith('BOTMUX_')&&key!=='BOTMUX_FENCED_RUN')})+'\\n');
if(process.argv.includes('--version'))console.log('codex-cli 0.134.0');
else if(process.argv.includes('--help'))console.log('--profile');
else console.log(JSON.stringify({models:[{slug:source,visibility:'list',service_tiers:[{id:'priority'}]}]}));
`, { mode: 0o700 });
  const ids = ['source-a', 'source-b'].map((source, index) => {
    const home = join(root, source); mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(join(home, '.codex', `${source}.config.toml`), 'model="test"\n');
    const file = join(root, index === 0 ? 'config.json' : 'second.json');
    writeFileSync(file, JSON.stringify({ botId: source, secretEnv: 'STRANGE_TRANSPORT_CREDENTIAL', allowedUsers: ['alice'], coreUrl: `http://127.0.0.1:${19700 + index}`,
      managedCore: { botId: `local_source_${index}`, cli: 'codex', backend: 'pty', port: 19700 + index, workingDirectory: root, stateDir: join(root, `core-${index}`),
        botConfig: { cliRuntime: { id: `fixture-${index}`, executable: bin }, cliPathOverride: bin, env: { HOME: home, PROBE_SOURCE: source } } } }), { mode: 0o600 });
    return wecomConfigId(file);
  });
  writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [join(root, 'second.json')] }));
  return { root, log, ids, service: new WecomDashboardConfig(root) };
}
describe('WeCom read-only CLI probes keep each source environment isolated', () => {
  it.each(['models', 'availability'] as const)('does not pass the persisted core profile to a different-selection %s probe', async kind => {
    const f = fixture(), log = join(f.root, `mismatch-${kind}.json`);
    const source = `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({profile:!!process.env.BOTMUX_CORE_BOT_CONFIG,nestedSecret:!!process.env.BOTMUX_CORE_BOT_CONFIG?.includes('fake-private-profile-token'),sourceSecret:!!process.env.PRIVATE_PROFILE_TOKEN,gateway:!!process.env.STRANGE_TRANSPORT_CREDENTIAL,core:!!process.env.BOTMUX_IPC_SECRET,host:process.env.SAFE_HOST_MARKER==='safe'}));console.log(JSON.stringify({schema_version:1,models:[{cli_type:'codex',id:'mismatch-model'}]}));
`;
    for (const name of ['aiden', 'forge', 'traex']) writeFileSync(join(f.root, name), source, { mode: 0o700 });
    await f.service.patch(f.ids[0], { revision: f.service.get(f.ids[0]).revision, botConfig: { env: { PRIVATE_PROFILE_TOKEN: 'fake-private-profile-token', PROBE_SOURCE: 'source-a' } } });
    vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`); vi.stubEnv('STRANGE_TRANSPORT_CREDENTIAL', 'fake-gateway-token'); vi.stubEnv('BOTMUX_IPC_SECRET', 'fake-core-token'); vi.stubEnv('SAFE_HOST_MARKER', 'safe');
    await f.service.cliProbe(f.ids[0], kind, kind === 'models' ? 'aiden-x-codex' : 'forge-x-traex');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ profile: false, nestedSecret: false, sourceSecret: false, gateway: false, core: false, host: true });
  });
  it.each(['coco', 'opencode', 'doubao'])('preserves the sanitized source environment in the %s adapter detector', async cli => {
    const f = fixture(), log = join(f.root, `${cli}.json`), executable = join(f.root, `${cli}-probe.cjs`);
    writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({source:process.env.PROBE_SOURCE,gateway:!!process.env.STRANGE_TRANSPORT_CREDENTIAL,wecom:!!process.env.WECOM_BOT_SECRET,coreSecret:!!process.env.BOTMUX_IPC_SECRET}));console.log('{"models":[]}');
`, { mode: 0o700 });
    await f.service.patch(f.ids[0], { revision: f.service.get(f.ids[0]).revision, cli, replaceCliSelection: true, botConfig: { cliPathOverride: executable, env: { PROBE_SOURCE: cli } } });
    vi.stubEnv('STRANGE_TRANSPORT_CREDENTIAL', 'fake-gateway-token'); vi.stubEnv('WECOM_BOT_SECRET', 'fake-wecom-token'); vi.stubEnv('BOTMUX_IPC_SECRET', 'fake-core-token');
    await f.service.cliProbe(f.ids[0], 'models', cli);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ source: cli, gateway: false, wecom: false, coreSecret: false });
  });
  it('reads the selected ZCode provider catalog from its source environment', async () => {
    const f = fixture(), source = join(f.root, 'source-providers.json'), ambient = join(f.root, 'ambient-providers.json');
    const catalog = (id: string) => JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: id, config: { personalModelIds: ['model'] } }] } } });
    writeFileSync(source, catalog('source')); writeFileSync(ambient, catalog('ambient'));
    vi.stubEnv('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', ambient);
    await f.service.patch(f.ids[0], { revision: f.service.get(f.ids[0]).revision, cli: 'zcode', replaceCliSelection: true, botConfig: { env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: source } } });
    expect((await f.service.cliProbe(f.ids[0], 'models', 'zcode')).models).toEqual(['source/model']);
  });
  it('strips custom transport credentials from the special Aiden model detector too', async () => {
    const f = fixture(), log = join(f.root, 'aiden-probe.json');
    writeFileSync(join(f.root, 'aiden'), `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({gateway:!!process.env.STRANGE_TRANSPORT_CREDENTIAL,wecom:!!process.env.WECOM_BOT_SECRET,coreSecret:!!process.env.BOTMUX_IPC_SECRET}));
console.log(JSON.stringify({schema_version:1,models:[{cli_type:'codex',id:'aiden-catalog'}]}));
`, { mode: 0o700 });
    vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`); vi.stubEnv('STRANGE_TRANSPORT_CREDENTIAL', 'fake-gateway-token'); vi.stubEnv('WECOM_BOT_SECRET', 'fake-wecom-token'); vi.stubEnv('BOTMUX_IPC_SECRET', 'fake-core-token');
    await f.service.cliProbe(f.ids[0], 'models', 'aiden-x-codex');
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ gateway: false, wecom: false, coreSecret: false });
  });
  it('keeps concurrent source probes and their real child environments separate without transport credentials', async () => {
    const f = fixture(); vi.stubEnv('STRANGE_TRANSPORT_CREDENTIAL', 'fake-gateway-token'); vi.stubEnv('WECOM_BOT_SECRET', 'fake-wecom-token'); vi.stubEnv('BOTMUX_IPC_SECRET', 'fake-core-token');
    const models = await Promise.all(f.ids.map(id => f.service.cliProbe(id, 'models', 'codex')));
    expect(models[0].models).toEqual(['source-a']); expect(models[1].models).toEqual(['source-b']);
    const profiles = await Promise.all(f.ids.map(id => f.service.codexProfiles(id)));
    expect(profiles[0].candidates.map(item => item.name)).toEqual(['source-a']); expect(profiles[1].candidates.map(item => item.name)).toEqual(['source-b']);
    const observations = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(observations.length).toBeGreaterThanOrEqual(6);
    expect(new Set(observations.map(item => item.source))).toEqual(new Set(['source-a', 'source-b']));
    for (const observation of observations) {
      expect(observation.gateway).toBe(false); expect(observation.wecom).toBe(false);
      expect(observation.internal).not.toContain('BOTMUX_IPC_SECRET'); expect(observation.internal).not.toContain('BOTMUX_CORE_BOT_CONFIG'); expect(observation.internal).not.toContain('BOTMUX_OWNER_OPEN_ID');
    }
    for (const id of f.ids) { const text = JSON.stringify(f.service.environment(id)); expect(text).not.toContain('fake-gateway-token'); expect(text).not.toContain('fake-core-token'); expect(text).not.toContain('BOTMUX_CORE_BOT_CONFIG'); }
  });
  it.each(['anonymous', 'h5', 'platform-owner'])('refuses every probe before invocation for %s identity', async kind => {
    const sessions = new DashboardSessionStore(), h5 = sessions.create('ou_fixture_allowed').identity;
    const identity = resolveDashboardIdentity({ legacyCookie: kind === 'platform-owner' ? 'active' : undefined, activeToken: 'active',
      roleHeader: kind === 'platform-owner' ? 'owner' : undefined, actorHeader: undefined, scopesHeader: 'dashboard:manage', platformMachineId: kind === 'platform-owner' ? 'machine' : null,
      platformActorScope: value => value, legacyAuthSessionId: value => value, h5: kind === 'h5' ? h5 : null });
    const cliProbe = vi.fn(), codexProfiles = vi.fn(), environment = vi.fn();
    for (const route of ['environment', 'codex-profiles', 'cli-options/availability?key=codex', 'cli-options/models?key=codex']) {
      const writeHead = vi.fn(), end = vi.fn();
      await handleWecomConnectionsApi({ method: 'GET' } as IncomingMessage, { writeHead, end } as unknown as ServerResponse,
        new URL(`http://fixture/api/wecom/connections/${'a'.repeat(64)}/${route}`),
        { hostAdmin: identity?.kind === 'legacy-dashboard', csrfValid: false, configuration: { get: vi.fn(), patch: vi.fn(), cliProbe, codexProfiles, environment } });
      expect(writeHead).toHaveBeenCalledWith(403, expect.anything());
    }
    expect(cliProbe).not.toHaveBeenCalled(); expect(codexProfiles).not.toHaveBeenCalled(); expect(environment).not.toHaveBeenCalled(); sessions.revokeAuthSession(h5.authSessionId);
  });
});
