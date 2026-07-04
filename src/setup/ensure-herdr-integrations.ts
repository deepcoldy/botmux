/**
 * Install herdr agent integrations for the CLI adapters configured in
 * bots.json. herdr integrations are official hooks/plugins that report
 * semantic agent state (working/blocked/idle/done) back to herdr — without
 * them, herdr falls back to screen heuristics, which are noisier.
 *
 * Per user decision in setup, we only install integrations for CLIs that
 * the current `bots.json` actually uses. Mappings come from
 * https://herdr.dev/docs/integrations/ (claude/codex/opencode/hermes are
 * the ones with botmux adapter equivalents). The `pi`, `omp`, `qodercli`
 * upstream integrations have no botmux adapter and are not auto-installed.
 *
 * Like ensureTmux/ensureHerdr, this never throws — failures only generate
 * warnings. The caller decides whether to surface them.
 */
import { execSync, spawnSync } from 'node:child_process';
import type { CliId } from '../adapters/cli/types.js';

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

export interface HerdrIntegrationResult {
  /** Integrations we attempted (after dedup + filtering by available CLIs). */
  attempted: string[];
  /** Newly installed during this run. */
  installed: string[];
  /** Already-present integrations we skipped. */
  alreadyInstalled: string[];
  /** Integrations whose `herdr integration install` returned non-zero. */
  failed: { name: string; reason: string }[];
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

function installSingleIntegration(name: string): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync('herdr', ['integration', 'install', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    encoding: 'utf-8',
  });
  if (result.status === 0) return { ok: true };
  const stderr = (result.stderr ?? '').toString().trim();
  const stdout = (result.stdout ?? '').toString().trim();
  return {
    ok: false,
    reason: stderr || stdout || `exit ${result.status}`,
  };
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
  for (const cli of seenCli) {
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
      result.failed.push({ name, reason: r.reason });
    }
  }

  return result;
}
