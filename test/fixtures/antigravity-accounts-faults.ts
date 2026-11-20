import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: antigravity-accounts-faults.ts <temp-root>');

type Service = typeof import('../../src/services/antigravity-accounts.js');
type Opts = import('../../src/services/antigravity-accounts.js').AntigravityAccountStoreOptions;
const nowMs = Date.parse('2026-11-20T12:00:00Z');
const token = (
  email: string,
  access = `access-${email}`,
  refresh = `refresh-${email}`,
  expiry = '2026-11-20T14:00:00Z',
) => JSON.stringify({
  id_token_email: email,
  token: { access_token: access, refresh_token: refresh, expiry, token_type: 'Bearer' },
});
function writeToken(path: string, raw: string): void {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, raw, { mode: 0o600 });
}
function fixture(name: string) {
  const base = join(root, name);
  const homeDir = join(base, 'home');
  const botmuxConfigDir = join(base, 'botmux');
  const liveTokenPath = join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const opts: Opts = { homeDir, botmuxConfigDir, liveTokenPath, now: () => nowMs, platform: 'linux', env: {} };
  fs.mkdirSync(base, { recursive: true });
  return { base, opts, liveTokenPath, botmuxConfigDir };
}
function seedTwoAccounts(svc: Service, f: ReturnType<typeof fixture>) {
  writeToken(f.liveTokenPath, token('a@example.test'));
  svc.saveAntigravityAccount('acc1', f.opts);
  const second = join(f.base, 'second.json');
  writeToken(second, token('b@example.test'));
  svc.saveAntigravityAccount('acc2', { ...f.opts, sourceTokenPath: second });
}

const originalFsync = fs.fsyncSync;
const originalRename = fs.renameSync;
const originalUnlink = fs.unlinkSync;
let fsyncFaultArmed = false;
let fsyncFaultEnabled = false;
let fsyncFaultPattern: RegExp = /\/state\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
let fsyncInjected = false;
let failStateRenameTarget: string | undefined;
let stateRenameInjected = false;
let failUnlinkTarget: string | undefined;
let unlinkInjected = false;

// Install every hook BEFORE loading the service/atomic-write module. Node's
// syncBuiltinESMExports then publishes the wrappers to named builtin imports;
// each scenario only changes plain JS triggers afterwards.
fs.fsyncSync = function patched(fd: number): void {
  const directory = fs.fstatSync(fd).isDirectory();
  let path = '';
  try { path = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* annotation only */ }
  if (fsyncFaultEnabled && !directory && fsyncFaultPattern.test(path)) fsyncFaultArmed = true;
  if (fsyncFaultEnabled && fsyncFaultArmed && directory) {
    fsyncFaultEnabled = false;
    fsyncFaultArmed = false;
    fsyncInjected = true;
    throw Object.assign(new Error('injected post-rename directory fsync EIO'), { code: 'EIO' });
  }
  return originalFsync(fd);
};
fs.renameSync = function patched(from: fs.PathLike, to: fs.PathLike): void {
  if (failStateRenameTarget && String(to) === failStateRenameTarget) {
    failStateRenameTarget = undefined;
    stateRenameInjected = true;
    throw Object.assign(new Error('injected state rename EIO'), { code: 'EIO' });
  }
  return originalRename(from, to);
};
fs.unlinkSync = function patched(path: fs.PathLike): void {
  if (failUnlinkTarget && String(path) === failUnlinkTarget) {
    unlinkInjected = true;
    throw Object.assign(new Error('injected token unlink EACCES'), { code: 'EACCES' });
  }
  return originalUnlink(path);
};
syncBuiltinESMExports();

const results: Record<string, unknown> = {};
const svc = await import('../../src/services/antigravity-accounts.js');
{
  const f = fixture('post-rename-fsync');
  seedTwoAccounts(svc, f);
  const third = join(f.base, 'third.json');
  writeToken(third, token('c@example.test'));
  const statePath = join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json');
  fsyncFaultEnabled = true;
  let thrown = '';
  try { svc.saveAntigravityAccount('acc3', { ...f.opts, sourceTokenPath: third }); }
  catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  finally { fsyncFaultEnabled = false; fsyncFaultArmed = false; }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  results.postRenameFsync = {
    injected: fsyncInjected,
    thrown,
    persistedIds: state.accounts.map((a: { id: string }) => a.id),
    tokenExists: fs.existsSync(join(f.botmuxConfigDir, 'antigravity-accounts', 'tokens', 'acc3.json')),
    acc3Valid: svc.inspectAntigravityAccounts(f.opts).accounts.find(a => a.id === 'acc3')?.hasValidToken,
  };
}
{
  const f = fixture('live-post-rename-fsync');
  seedTwoAccounts(svc, f);
  fsyncInjected = false;
  fsyncFaultPattern = /\/antigravity-oauth-token\.\d+\.[0-9a-f]{8}\.tmp$/;
  fsyncFaultEnabled = true;
  let thrown = '';
  try { svc.useAntigravityAccount('acc2', f.opts); }
  catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  finally { fsyncFaultEnabled = false; fsyncFaultArmed = false; fsyncFaultPattern = /\/state\.json\.\d+\.[0-9a-f]{8}\.tmp$/; }
  const state = JSON.parse(fs.readFileSync(join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json'), 'utf8'));
  results.livePostRenameFsync = {
    injected: fsyncInjected,
    thrown,
    activeId: state.activeId,
    liveEmail: JSON.parse(fs.readFileSync(f.liveTokenPath, 'utf8')).id_token_email,
    liveMatchesActive: svc.inspectAntigravityAccounts(f.opts).liveTokenMatchesActive,
  };
}
{
  const f = fixture('vault-post-rename-fsync');
  writeToken(f.liveTokenPath, token('a@example.test'));
  svc.saveAntigravityAccount('acc1', f.opts);
  const second = join(f.base, 'second.json');
  writeToken(second, token('b@example.test'));
  fsyncInjected = false;
  fsyncFaultPattern = /\/tokens\/acc2\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
  fsyncFaultEnabled = true;
  let thrown = '';
  try { svc.saveAntigravityAccount('acc2', { ...f.opts, sourceTokenPath: second }); }
  catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  finally { fsyncFaultEnabled = false; fsyncFaultArmed = false; fsyncFaultPattern = /\/state\.json\.\d+\.[0-9a-f]{8}\.tmp$/; }
  results.vaultPostRenameFsync = {
    injected: fsyncInjected,
    thrown,
    acc2Valid: svc.inspectAntigravityAccounts(f.opts).accounts.find(a => a.id === 'acc2')?.hasValidToken,
  };
}
{
  const f = fixture('save-state-rename-rollback');
  writeToken(f.liveTokenPath, token('a@example.test', 'OLD_A_ACCESS', 'OLD_A_REFRESH', '2026-11-20T13:00:00Z'));
  svc.saveAntigravityAccount('acc1', f.opts);
  const isolated = join(f.base, 'isolated.json');
  writeToken(isolated, token('b@example.test', 'NEW_B_ACCESS', 'NEW_B_REFRESH', '2026-11-20T14:00:00Z'));
  const statePath = join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json');
  stateRenameInjected = false;
  failStateRenameTarget = join(fs.realpathSync(dirname(statePath)), 'state.json');
  let thrown = '';
  try { svc.saveAntigravityAccount('acc1', { ...f.opts, sourceTokenPath: isolated, force: true }); }
  catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  failStateRenameTarget = undefined;
  fs.rmSync(isolated);
  // A still-running old agy publishes a fresher A after the failed save.
  writeToken(f.liveTokenPath, token('a@example.test', 'OLD_AGY_REFRESHED_ACCESS', 'OLD_AGY_REFRESHED_REFRESH', '2026-11-20T15:00:00Z'));
  const reconciliation = svc.reconcileActiveAntigravityToken(f.opts);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const vault = JSON.parse(fs.readFileSync(join(f.botmuxConfigDir, 'antigravity-accounts', 'tokens', 'acc1.json'), 'utf8'));
  const recoveryPath = join(f.botmuxConfigDir, 'antigravity-accounts', 'recovery', 'acc1.json');
  results.saveStateRenameRollback = {
    injected: stateRenameInjected,
    thrown,
    reconciliation,
    stateEmail: state.accounts[0]?.email,
    liveEmail: JSON.parse(fs.readFileSync(f.liveTokenPath, 'utf8')).id_token_email,
    vaultEmail: vault.id_token_email,
    vaultAccess: vault.token.access_token,
    recoveryExists: fs.existsSync(recoveryPath),
    recoveryContainsNewB: fs.existsSync(recoveryPath) && fs.readFileSync(recoveryPath, 'utf8').includes('NEW_B_REFRESH'),
  };
}
{
  const f = fixture('metadata-state-rename-failure');
  writeToken(f.liveTokenPath, token('', 'OLD_ACCESS', 'SHARED_REFRESH', '2026-11-20T13:00:00Z'));
  svc.saveAntigravityAccount('noemail', f.opts);
  writeToken(f.liveTokenPath, token('new@example.test', 'NEW_ACCESS', 'SHARED_REFRESH', '2026-11-20T15:00:00Z'));
  const statePath = join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json');
  stateRenameInjected = false;
  failStateRenameTarget = join(fs.realpathSync(dirname(statePath)), 'state.json');
  const rotation = svc.rotateAntigravityAccountOnQuotaLimit({}, f.opts);
  failStateRenameTarget = undefined;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const duplicateSource = join(f.base, 'duplicate.json');
  writeToken(duplicateSource, token('new@example.test', 'NEW_ACCESS', 'SHARED_REFRESH', '2026-11-20T15:00:00Z'));
  let duplicateError = '';
  try { svc.saveAntigravityAccount('duplicate', { ...f.opts, sourceTokenPath: duplicateSource }); }
  catch (err) { duplicateError = err instanceof Error ? err.message : String(err); }
  results.metadataStateRenameFailure = {
    injected: stateRenameInjected,
    outcome: rotation.outcome,
    stateEmailAfterFailure: state.accounts[0]?.email ?? null,
    duplicateError,
    accountIds: svc.inspectAntigravityAccounts(f.opts).accounts.map(a => a.id),
  };
}
{
  const f = fixture('state-rename-failure');
  seedTwoAccounts(svc, f);
  const statePath = join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json');
  stateRenameInjected = false;
  failStateRenameTarget = join(fs.realpathSync(dirname(statePath)), 'state.json');
  const result = svc.rotateAntigravityAccountOnQuotaLimit({ failedAccountId: 'acc1', cooldownUntilMs: nowMs + 60_000 }, f.opts);
  failStateRenameTarget = undefined;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  results.stateRenameFailure = {
    injected: stateRenameInjected,
    outcome: result.outcome,
    liveEmail: JSON.parse(fs.readFileSync(f.liveTokenPath, 'utf8')).id_token_email,
    activeId: state.activeId,
    acc1Cooldown: state.accounts.find((a: { id: string }) => a.id === 'acc1')?.cooldownUntilMs,
    liveMatchesActive: svc.inspectAntigravityAccounts(f.opts).liveTokenMatchesActive,
  };
}
{
  const f = fixture('remove-unlink-failure');
  writeToken(f.liveTokenPath, token('a@example.test'));
  svc.saveAntigravityAccount('acc1', f.opts);
  const tokenPath = join(f.botmuxConfigDir, 'antigravity-accounts', 'tokens', 'acc1.json');
  failUnlinkTarget = tokenPath;
  let thrown = '';
  try { svc.removeAntigravityAccount('acc1', f.opts); }
  catch (err) { thrown = err instanceof Error ? err.message : String(err); }
  finally { failUnlinkTarget = undefined; }
  const state = JSON.parse(fs.readFileSync(join(f.botmuxConfigDir, 'antigravity-accounts', 'state.json'), 'utf8'));
  const tokenStillExistsAfterFailure = fs.existsSync(tokenPath);
  const retry = svc.removeAntigravityAccount('acc1', f.opts);
  results.removeUnlinkFailure = {
    injected: unlinkInjected,
    thrown,
    persistedIds: state.accounts.map((a: { id: string }) => a.id),
    tokenStillExists: tokenStillExistsAfterFailure,
    retry,
    tokenExistsAfterRetry: fs.existsSync(tokenPath),
  };
}
console.log(JSON.stringify(results));
