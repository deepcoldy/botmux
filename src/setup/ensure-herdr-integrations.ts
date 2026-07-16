/**
 * Install herdr agent integrations for the CLI adapters configured in
 * bots.json. herdr integrations are official hooks/plugins that report
 * semantic agent state (working/blocked/idle/done) back to herdr — without
 * them, herdr falls back to screen heuristics, which are noisier.
 *
 * Per user decision in setup, we only install integrations for CLIs that
 * the current `bots.json` actually uses. Mappings come from
 * https://herdr.dev/docs/integrations/ (claude/codex/opencode/hermes are
 * the ones with botmux adapter equivalents). TraeX is not built into herdr
 * upstream yet; optional TraeX plugin bootstrap is dashboard/env opt-in and
 * uses operator-supplied plugin source/ref fields. The `pi`, `omp`, `qodercli` upstream
 * integrations have no botmux adapter and are not auto-installed.
 *
 * Like ensureTmux/ensureHerdr, this never throws — failures only generate
 * warnings. The caller decides whether to surface them.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import { resolveHerdrTraexPluginConfig } from '../config.js';
import { withFileLock } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * Map botmux CliId → herdr integration name. CLIs with no upstream
 * integration are intentionally absent (we won't try to install them).
 * `codex-app` shares the same `~/.codex` config as `codex`, so they
 * dedupe to the same `codex` install.
 */
const CLI_TO_HERDR_INTEGRATION: Partial<Record<CliId, string>> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-app': 'codex',
  'opencode': 'opencode',
  'hermes': 'hermes',
};

const TRAEX_PLUGIN_ID = 'com.traex.herdr-integration';

const TRAEX_INSTALL_LOCK_WAIT_MS = 200_000;

/**
 * Author-recommended plugin source, surfaced in the dashboard ONLY as a one-click
 * suggestion the operator must actively select (never a silent default / auto-install).
 *
 * Intentionally EMPTY this round: the only known community TraeX plugin's
 * `scripts/install.sh` uses BSD `sed -i ''` and fails on Linux (the daemon's own
 * platform), so a one-click default would action-fail. Re-populate with a
 * `{source, ref: <verified commit SHA>}` (NOT a branch — avoid drift) once upstream
 * install.sh is fixed and validated on herdr 0.7.3 / Linux.
 */
export const TRAEX_RECOMMENDED_SOURCE = '';
export const TRAEX_RECOMMENDED_REF = '';

function traexMarkerPath(): string {
  return join(homedir(), '.botmux', 'state', 'herdr-traex-plugin.json');
}

function traexPluginInstallCommand(source: string, ref: string): string {
  const install = `herdr plugin install ${source}${ref ? ` --ref ${ref}` : ''} --yes`;
  return `${install} && herdr plugin action invoke ${TRAEX_PLUGIN_ID}.install`;
}

/** botmux-owned marker recording the last (source, ref) whose install action
 *  fully completed, keyed by herdr's authoritative resolved_commit. Lives in
 *  ~/.botmux/state (NOT the desired config) so a failed action leaves no marker
 *  and simply retries next time, while a source/ref change forces
 *  a re-run — without needlessly re-cloning when nothing changed. */
interface TraexMarker { source: string; ref: string; resolvedCommit: string; actionInvokedAt: string; }

function readTraexMarker(): TraexMarker | undefined {
  try {
    const m = JSON.parse(readFileSync(traexMarkerPath(), 'utf-8'));
    return m && typeof m === 'object' && typeof m.resolvedCommit === 'string' ? m as TraexMarker : undefined;
  } catch { return undefined; }
}

function writeTraexMarker(m: TraexMarker): void {
  const p = traexMarkerPath();
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(m, null, 2), { mode: 0o600 });
}

/** Capability probe: herdr < 0.7.0 has no `plugin` subcommand (`herdr plugin
 *  --help` exits non-zero). Returns the current version for the operator hint. */
function probeHerdrVersion(): string | undefined {
  try {
    const out = execSync('herdr --version', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : out.trim() || undefined;
  } catch { return undefined; }
}

function herdrSupportsPlugins(): { ok: true } | { ok: false; version?: string } {
  const probe = spawnSync('herdr', ['plugin', '--help'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf-8' });
  if (probe.status === 0) return { ok: true };
  return { ok: false, version: probeHerdrVersion() };
}

interface TraexPluginState { present: boolean; source?: string; requestedRef?: string; resolvedCommit?: string; }

/** Read the traex plugin's authoritative source metadata from herdr 0.7.x
 *  `plugin list --json` (`source.owner/repo[/subdir]`, `requested_ref`,
 *  `resolved_commit`). Never throws. */
async function getTraexPluginState(): Promise<TraexPluginState> {
  const result = await spawnHerdrAsync(['plugin', 'list', '--json'], 5000);
  if (!result.ok) return { present: false };
  try {
    const plugins = pluginsArrayFromJson(JSON.parse(result.stdout));
    if (!plugins) return { present: result.stdout.includes(TRAEX_PLUGIN_ID) };
    const p = plugins.find((x: any) => x?.plugin_id === TRAEX_PLUGIN_ID || x?.id === TRAEX_PLUGIN_ID || x?.name === TRAEX_PLUGIN_ID);
    if (!p) return { present: false };
    const src = (p.source && typeof p.source === 'object') ? p.source : {};
    const source = src.owner && src.repo
      ? `${src.owner}/${src.repo}${src.subdir ? `/${src.subdir}` : ''}`
      : (typeof p.source === 'string' ? p.source : undefined);
    return {
      present: true,
      source,
      requestedRef: src.requested_ref ?? p.requested_ref,
      resolvedCommit: src.resolved_commit ?? p.resolved_commit,
    };
  } catch {
    return { present: result.stdout.includes(TRAEX_PLUGIN_ID) };
  }
}

export interface HerdrIntegrationResult {
  /** Integrations we attempted (after dedup + filtering by available CLIs). */
  attempted: string[];
  /** Newly installed during this run. */
  installed: string[];
  /** Already-present integrations we skipped. */
  alreadyInstalled: string[];
  /** Integrations whose `herdr integration install` returned non-zero. */
  failed: { name: string; reason: string; manualCommand?: string }[];
  /** TraeX herdr plugin status, when a herdr+traex bot exists. */
  traexPlugin?: {
    attempted: boolean;
    enabled: boolean;
    source?: string;
    ref?: string;
    installed: boolean;
    alreadyInstalled: boolean;
    actionInvoked: boolean;
    skippedReason?: 'disabled' | 'missing_source' | 'plugin_unsupported';
    /** Current herdr version, set when skippedReason === 'plugin_unsupported'. */
    herdrVersion?: string;
    failed?: { step: 'install' | 'action'; reason: string; manualCommand: string };
  };
  /** CliIds in bots.json that have no upstream herdr integration mapping. */
  unsupportedCliIds: CliId[];
}

/**
 * Read `herdr integration status` and parse out which integrations are
 * already installed. Output format from herdr varies across versions, so
 * we use a forgiving line-based regex: any line containing the integration
 * name plus a clear "installed" / "version N" marker counts as installed.
 *
 * Returns undefined if the command itself failed (herdr binary issue) —
 * caller should treat that as "unknown" and attempt install anyway; herdr
 * itself short-circuits a duplicate install.
 */
function listInstalledIntegrations(): Set<string> | undefined {
  try {
    const out = execSync('herdr integration status', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const installed = new Set<string>();
    for (const line of out.split('\n')) {
      const lower = line.toLowerCase();
      // Match e.g. "claude  installed (version 4)" or "codex: version 4 installed"
      // Be forgiving: presence of integration name + "version" or "installed" suffices.
      for (const name of new Set(Object.values(CLI_TO_HERDR_INTEGRATION))) {
        if (!name) continue;
        if (lower.includes(name) && (lower.includes('installed') || /version\s*\d+/.test(lower))) {
          installed.add(name);
        }
      }
    }
    return installed;
  } catch {
    return undefined;
  }
}

function spawnHerdr(args: string[], timeout = 60_000): { ok: true; stdout: string } | { ok: false; reason: string; stdout: string } {
  const result = spawnSync('herdr', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    encoding: 'utf-8',
  });
  const stderr = (result.stderr ?? '').toString().trim();
  const stdout = (result.stdout ?? '').toString().trim();
  if (result.status === 0) return { ok: true, stdout };
  return {
    ok: false,
    reason: stderr || stdout || (result.error ? String(result.error.message ?? result.error) : `exit ${result.status}`),
    stdout,
  };
}

function installSingleIntegration(name: string): { ok: true } | { ok: false; reason: string } {
  const result = spawnHerdr(['integration', 'install', name]);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * Async sibling of `spawnHerdr`. The TraeX plugin path uses this (not the sync
 * `spawnSync`) so it can also run live from the dashboard's settings-write
 * handler without blocking the daemon event loop for up to 120s during a
 * `herdr plugin install`. Never rejects — resolves an ok/err discriminated
 * union just like `spawnHerdr`.
 */
export function spawnHerdrAsync(args: string[], timeout = 60_000): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: { ok: true; stdout: string } | { ok: false; reason: string; stdout: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(r);
    };
    // detached: the child leads its own process group, so on timeout we SIGKILL the
    // WHOLE group (herdr + any git/npm/install-script it spawned) rather than just the
    // direct child — which could otherwise keep writing the plugin dir / ~/.trae in the
    // background and race a retry. POSIX only; Windows would need a different teardown.
    const child = spawn('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      // Settle on 'close' (group reaped); bound the wait so a wedged group can't hang us.
      grace = setTimeout(() => finish({ ok: false, reason: `timeout after ${timeout}ms`, stdout: stdout.trim() }), 3000);
    }, timeout);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => finish({ ok: false, reason: String((err as any)?.message ?? err), stdout: stdout.trim() }));
    child.on('close', (code) => {
      const out = stdout.trim();
      if (timedOut) return finish({ ok: false, reason: `timeout after ${timeout}ms`, stdout: out });
      if (code === 0) return finish({ ok: true, stdout: out });
      finish({ ok: false, reason: stderr.trim() || out || `exit ${code}`, stdout: out });
    });
  });
}

function pluginsArrayFromJson(parsed: any): any[] | undefined {
  if (Array.isArray(parsed?.result?.plugins)) return parsed.result.plugins;
  if (Array.isArray(parsed?.plugins)) return parsed.plugins;
  if (Array.isArray(parsed?.data?.plugins)) return parsed.data.plugins;
  if (Array.isArray(parsed)) return parsed;
  return undefined;
}

/**
 * Install / update / verify the TraeX herdr plugin for an operator-supplied
 * (source, ref). Async so it runs both at startup (awaited by
 * ensureHerdrIntegrations) and live from the dashboard settings-write handler.
 *
 * Correct idempotency (herdr 0.7.x): plugin-ID presence alone is NOT "done" —
 *  - needsInstall = plugin absent OR its herdr `source`/`requested_ref` metadata
 *    differs from the desired (source, ref) → `plugin install` (herdr `replaces:`
 *    and re-checks out on a changed ref/source);
 *  - needsAction = our own success marker is missing or points at a different
 *    `resolved_commit` → re-run the install action. A prior action failure leaves
 *    NO marker, so we retry the action next time WITHOUT a needless re-clone.
 * The whole check→install→action→marker sequence runs under a cross-process file
 * lock so concurrent triggers (two tabs, or a dashboard PUT racing startup) can't
 * double-clone the repo or double-write ~/.trae hooks.
 */
export async function installTraexPluginNow(source: string, ref: string): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> {
  const src = source.trim();
  const rf = ref.trim();
  const base = { attempted: false, enabled: true, source: src || undefined, ref: rf || undefined, installed: false, alreadyInstalled: false, actionInvoked: false };

  if (!src) return { ...base, skippedReason: 'missing_source' };

  // Capability gate: herdr < 0.7.0 has no `plugin` subcommand at all.
  const cap = herdrSupportsPlugins();
  if (!cap.ok) return { ...base, skippedReason: 'plugin_unsupported', herdrVersion: cap.version };

  const manualCommand = traexPluginInstallCommand(src, rf);

  try {
    // The lock file is `<marker>.lock`; ensure the state dir exists before acquiring it.
    mkdirSync(dirname(traexMarkerPath()), { recursive: true });
    return await withFileLock(traexMarkerPath(), async () => {
      const before = await getTraexPluginState();
      // Treat missing metadata as a mismatch too. On supported herdr versions
      // source/requested_ref are authoritative; silently accepting an unknown
      // source would defeat the operator's trust boundary.
      const sourceMismatch = before.present && (before.source ?? '') !== src;
      const refMismatch = before.present && (before.requestedRef ?? '') !== rf;
      const needsInstall = !before.present || sourceMismatch || refMismatch;

      let installed = false;
      if (needsInstall) {
        console.log(`   安装 herdr TraeX plugin: ${src}${rf ? ` (--ref ${rf})` : ''}`);
        const install = await spawnHerdrAsync(['plugin', 'install', src, ...(rf ? ['--ref', rf] : []), '--yes'], 120_000);
        if (!install.ok) {
          return { ...base, attempted: true, failed: { step: 'install' as const, reason: install.reason, manualCommand } };
        }
        installed = true;
      }

      // Re-list for authoritative metadata only after an install. When nothing
      // changed, `before` is already the same snapshot and a second list would
      // widen the race surface without adding information.
      const after = installed ? await getTraexPluginState() : before;
      const installedSource = after.source ?? '';
      const installedRef = after.requestedRef ?? '';
      if (!after.present || installedSource !== src || installedRef !== rf || !after.resolvedCommit) {
        return {
          ...base,
          attempted: true,
          installed,
          failed: {
            step: 'install' as const,
            reason: `herdr 安装后元数据不匹配（source=${installedSource || '缺失'}, ref=${installedRef || '缺失'}, resolved_commit=${after.resolvedCommit || '缺失'}）`,
            manualCommand,
          },
        };
      }
      const resolvedCommit = after.resolvedCommit ?? '';
      const marker = readTraexMarker();
      const actionDone = !!marker
        && !!resolvedCommit
        && marker.source === src
        && marker.ref === rf
        && marker.resolvedCommit === resolvedCommit;

      let actionInvoked = false;
      if (!actionDone) {
        const action = await spawnHerdrAsync(['plugin', 'action', 'invoke', `${TRAEX_PLUGIN_ID}.install`], 60_000);
        if (!action.ok) {
          return { ...base, attempted: true, installed, failed: { step: 'action' as const, reason: action.reason, manualCommand } };
        }
        actionInvoked = true;
        try {
          writeTraexMarker({ source: src, ref: rf, resolvedCommit, actionInvokedAt: new Date().toISOString() });
        } catch (err: any) {
          return {
            ...base,
            attempted: true,
            installed,
            actionInvoked,
            failed: { step: 'action' as const, reason: `hooks 已写入，但状态 marker 保存失败：${err?.message ?? err}`, manualCommand },
          };
        }
      }

      return { ...base, attempted: true, source: src, ref: rf || undefined, installed, actionInvoked, alreadyInstalled: !installed && !actionInvoked };
    }, { maxWaitMs: TRAEX_INSTALL_LOCK_WAIT_MS });
  } catch (err: any) {
    return {
      ...base,
      attempted: true,
      failed: {
        step: 'install',
        reason: `安装锁失败：${err?.message ?? err}`,
        manualCommand,
      },
    };
  }
}

/**
 * Live (dashboard) path: when a settings-write flips the TraeX plugin config,
 * install immediately instead of waiting for the next daemon restart. Returns
 * undefined (no-op) unless the write actually touched `herdrTraexPlugin` AND
 * the resolved config is enabled with a non-empty `source` — so unrelated settings
 * writes never trigger an install, and enabling without a source stays a no-op
 * (the UI surfaces the required-source hint). `installFn` is injectable for tests.
 */
export async function maybeInstallTraexPluginOnSettingsChange(
  patchTouchedHerdrTraex: boolean,
  resolved: { enabled: boolean; source: string; ref: string } | undefined,
  installFn: (source: string, ref: string) => Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> = installTraexPluginNow,
): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']> | undefined> {
  if (!patchTouchedHerdrTraex) return undefined;
  if (!resolved?.enabled || !resolved.source.trim()) return undefined;
  return installFn(resolved.source, resolved.ref);
}

/**
 * Startup path: resolve the opt-in config (default OFF + operator-supplied
 * source/ref, no botmux default source), then delegate to installTraexPluginNow.
 */
async function ensureTraexPlugin(): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> {
  const cfg = resolveHerdrTraexPluginConfig();
  if (!cfg.enabled) {
    return { attempted: false, enabled: false, installed: false, alreadyInstalled: false, actionInvoked: false, skippedReason: 'disabled' };
  }
  if (!cfg.source) {
    return { attempted: false, enabled: true, installed: false, alreadyInstalled: false, actionInvoked: false, skippedReason: 'missing_source' };
  }
  return installTraexPluginNow(cfg.source, cfg.ref);
}

/**
 * Install herdr integrations for the given CLI ids. Caller is responsible
 * for ensuring `herdr` itself is on PATH first (use ensureHerdr).
 *
 * @param cliIds De-duped CliIds collected from bots.json. Order doesn't
 *               matter; we map → herdr integration → de-dup again before
 *               touching the filesystem.
 */
export async function ensureHerdrIntegrations(cliIds: Iterable<CliId>): Promise<HerdrIntegrationResult> {
  const seenCli = new Set<CliId>(cliIds);
  const unsupportedCliIds: CliId[] = [];
  const targetIntegrations = new Set<string>();
  const wantsTraex = seenCli.has('traex');
  for (const cli of seenCli) {
    if (cli === 'traex') continue; // handled by the community plugin path below.
    const integration = CLI_TO_HERDR_INTEGRATION[cli];
    if (!integration) {
      unsupportedCliIds.push(cli);
      continue;
    }
    targetIntegrations.add(integration);
  }

  const result: HerdrIntegrationResult = {
    attempted: [...targetIntegrations].sort(),
    installed: [],
    alreadyInstalled: [],
    failed: [],
    unsupportedCliIds,
  };

  if (wantsTraex) result.traexPlugin = await ensureTraexPlugin();
  if (targetIntegrations.size === 0) return result;

  const alreadyInstalled = listInstalledIntegrations();

  for (const name of result.attempted) {
    if (alreadyInstalled?.has(name)) {
      result.alreadyInstalled.push(name);
      continue;
    }
    console.log(`   安装 herdr integration: ${name}`);
    const r = installSingleIntegration(name);
    if (r.ok) {
      result.installed.push(name);
    } else {
      result.failed.push({ name, reason: r.reason, manualCommand: `herdr integration install ${name}` });
    }
  }

  return result;
}
