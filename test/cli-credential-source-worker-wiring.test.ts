import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const pool = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

describe('credentialsSourceDir daemon → worker cold-spawn wiring', () => {
  it('declares the field on init IPC and sends the configured value', () => {
    expect(types).toContain('credentialsSourceDir?: string; triggerUserAuth');
    const initStart = pool.indexOf('initMsg = {');
    const init = pool.slice(initStart, pool.indexOf('worker.send(initMsg)', initStart));
    expect(init).toContain('credentialsSourceDir: botCfg.credentialsSourceDir');
  });

  it('plans before provisioning and fails closed on refuse / unreadable source', () => {
    const plan = worker.indexOf('const credentialSourcePlan = planCredentialSource({');
    const gate = worker.indexOf('if (willRedirectCliData) {', plan);
    expect(plan).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(plan);
    const planBlock = worker.slice(plan, gate);
    expect(planBlock).toContain('willRedirectCliData,');
    expect(planBlock).toContain('    sandboxRequested,\n');
    expect(planBlock).toContain('wrapperCli: cfg.wrapperCli,');
    expect(planBlock).toContain('supportsReadIsolation: cliAdapter.supportsReadIsolation === true,');
    expect(planBlock).toContain('sessionDataDirPresent: !!process.env.SESSION_DATA_DIR,');
    expect(planBlock).toContain("credentialSourcePlan.kind === 'refuse'");
    expect(planBlock).toMatch(/kind === 'refuse'\) \{\s*throw new Error/);
    expect(planBlock).toMatch(/readCredentialSource\([^)]*\);\s*\} catch \(e\) \{\s*throw new Error/);
  });

  it('suppresses the shared-login seed and copies the source outside the best-effort block', () => {
    expect(worker).toContain('const fresh = claudeCredFromSource ? null : freshestClaudeCred();');
    const gate = worker.indexOf('if (willRedirectCliData) {', worker.indexOf('const credentialSourcePlan'));
    const provision = worker.indexOf('provisionIsolatedBotHome(', gate);
    const provisionEnd = worker.indexOf(');', provision);
    expect(worker.slice(provision, provisionEnd)).toContain('credentialSourceFiles !== undefined');
    const copy = worker.indexOf('if (credentialSourceFiles && claudeDataDir) {', provisionEnd);
    expect(copy).toBeGreaterThan(provisionEnd);
    const copyBlock = worker.slice(copy, worker.indexOf('\n    }\n', worker.indexOf('throw new Error(', copy)));
    expect(copyBlock).toContain('writeFileAtomic0600(join(claudeDataDir, name)');
    expect(copyBlock).not.toContain('writeCredIfChanged');
    expect(copyBlock).toContain('claudeAuthOverridesInSettingsLayers({');
    expect(copyBlock).toContain("userSettingsPath: join(claudeDataDir, 'settings.json'),");
    expect(copyBlock).toContain('workingDir: cfg.workingDir,');
    expect(copyBlock).toContain('claudeAuthOverrideKeys(process.env)');
    expect(copyBlock).toContain("reconcileClaudeAccountState(join(claudeDataDir, '.claude.json'), credentialSourceDir!)");
    expect(copyBlock).toContain("claudeStateAuthOverrides(join(claudeDataDir, '.claude.json'))");
    // Reconcile runs after the seed inside provisionIsolatedBotHome, and before the post-check.
    expect(copyBlock.indexOf('reconcileClaudeAccountState(')).toBeLessThan(copyBlock.indexOf('const overrides = ['));
    expect(copyBlock).toMatch(/if \(overrides\.length\) \{\s*throw new Error/);
    expect(worker).toContain('...(claudeCredFromSource ? { inheritClaudeEnvExclude: CLAUDE_AUTH_OVERRIDE_ENV_KEYS } : {})');
    expect(worker).toContain('perBotEnv: cfg.env,');
  });

  it('serializes every per-bot data-root writer and the post-check under one per-bot lock', () => {
    const start = worker.indexOf('const provisionBotHome = (): void => {');
    const end = worker.indexOf('withFileLockSync(provisionLock, provisionBotHome);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = worker.slice(start, end);
    const order = [
      'provisionIsolatedBotHome(',
      'writeFileAtomic0600(join(claudeDataDir, name)',
      'reconcileClaudeAccountState(',
      'ensureGatewayEntry({',
      'const overrides = [',
    ].map((m) => body.indexOf(m));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(body).toContain("const provisionLock = join(config.session.dataDir, 'credentials-source', `${cfg.larkAppId}.provision`);");
    expect(worker.slice(end - 400, end)).toContain('if (credentialSourceFiles) {');
  });

  it('never reattaches a persistent pane launched with a different credential source', () => {
    const gate = worker.indexOf('const launchedWith = readCredentialSourceStamp(config.session.dataDir, cfg.sessionId);');
    expect(gate).toBeGreaterThan(-1);
    const head = worker.lastIndexOf('if (willReattachPersistent && persistentSessionName', gate);
    expect(gate - head).toBeLessThan(200);
    const block = worker.slice(gate, worker.indexOf('// A pane created before asymmetric control framing', gate));
    expect(block).toContain("if (launchedWith !== (credentialSourceDir ?? null)) {");
    expect(block).toContain("if (postKillProbe !== 'missing') {");
    expect(block).toContain('willReattachPersistent = selectedBackend.isReattach === true;');
    expect(block).toMatch(/if \(willReattachPersistent\) \{\s*throw new Error/);
    // The gate runs after the last pre-existing reattach decision it depends on
    // and before spawn; the stamp is written only for a cold spawn.
    expect(gate).toBeGreaterThan(worker.indexOf('const paneRelayReattachSafe'));
    const stamp = worker.indexOf('writeCredentialSourceStamp(config.session.dataDir, cfg.sessionId, credentialSourceDir);');
    expect(stamp).toBeGreaterThan(worker.indexOf('Refusing unauthenticated Codex App reattach'));
    expect(worker.slice(stamp - 120, stamp)).toContain('if (!willReattachPersistent) {');
    expect(stamp).toBeLessThan(worker.indexOf('if (willReattachPersistent) {', stamp));
  });
});
