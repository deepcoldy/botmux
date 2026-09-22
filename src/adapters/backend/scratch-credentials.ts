/**
 * Scratch transport-credential enumeration.
 *
 * Scratch's threat model is integrity (host writes are COW-isolated), NOT
 * confidentiality — but the design still promises a "fixed credential mask":
 * the in-sandbox CLI must not be able to READ botmux/Lark transport secrets
 * from the real disk (it sends exclusively through the outbox relay). The
 * oncall whitelist gets this for free (the whole fs root is a fresh tmpfs and
 * only allow-listed paths exist); scratch mounts the REAL tree, so it must
 * enumerate and mask every secret explicitly.
 *
 * A hand-written list drifts (PR #1513 review found an early build that
 * listed only device-credential files and left bots.json readable). This
 * helper derives the set from the on-disk layout every spawn:
 *
 *  - every top-level FILE in each botmux authority home (bots.json + all
 *    atomic-write sidecars/backups, .dashboard-secret/-token/…);
 *  - every bot's send-cred.json under `<home>/bots/<appId>/`;
 *  - an external BOTS_CONFIG file (+ sidecar siblings) when set;
 *  - webhook signing key/secrets under the data dirs;
 *  - the shared lark-cli keystore (~/.lark-cli holds every app's secret).
 *
 * Paths that don't exist are skipped (the mask compiler existence-filters).
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

export interface ScratchSecretInput {
  /** All botmux authority homes (~/.botmux + custom BOTMUX_HOME variants). */
  botmuxHomes: readonly string[];
  /** Session data dirs (webhook secrets live here). */
  dataDirs: readonly string[];
  /** Resolved loaded BOTS_CONFIG path (may live outside any botmux home). */
  botsConfigPath?: string;
}

function isFileOrLink(p: string): boolean {
  try { return !lstatSync(p).isDirectory(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

export function enumerateScratchSecretPaths(input: ScratchSecretInput): string[] {
  const out = new Set<string>();
  const addFile = (p: string | undefined): void => {
    if (p && isFileOrLink(p)) out.add(p);
  };

  for (const home of input.botmuxHomes) {
    let entries: string[];
    try { entries = readdirSync(home); } catch { continue; }
    for (const name of entries) {
      const p = join(home, name);
      // Top-level FILES are daemon-level authority (bots.json + every
      // sidecar/backup, .dashboard-secret/-token). Directories (bots/, data/,
      // bin/, …) are NOT masked wholesale: the per-bot secret files inside
      // bots/ are enumerated right below, the data dir has its own webhook
      // entries, and the CLI may need non-secret siblings through COW.
      if (isFileOrLink(p)) {
        out.add(p);
      } else if (name === 'bots' && isDir(p)) {
        let appDirs: string[];
        try { appDirs = readdirSync(p); } catch { continue; }
        for (const app of appDirs) {
          addFile(join(p, app, 'send-cred.json'));
        }
      }
    }
  }

  // External BOTS_CONFIG (possibly outside any botmux home) + sidecars in the
  // same directory that share its basename prefix (bots.json.bak-*, .tmp …).
  if (input.botsConfigPath) {
    const cfg = input.botsConfigPath;
    addFile(cfg);
    const dir = dirname(cfg);
    const stem = basename(cfg);
    try {
      for (const name of readdirSync(dir)) {
        if (name !== stem && name.startsWith(stem)) addFile(join(dir, name));
      }
    } catch { /* */ }
  }

  // Webhook signing material in session data dirs.
  for (const dataDir of input.dataDirs) {
    addFile(join(dataDir, 'webhook-master.key'));
    addFile(join(dataDir, 'webhook-secrets.json'));
    addFile(join(dataDir, 'feedback-webhook-secrets.json'));
    addFile(join(dataDir, 'master.key'));
  }

  // Shared lark-cli keystore (cross-app appsecret_*.enc). The per-bot store
  // (~/.lark-cli-bots/<appId>) is deliberately NOT included — it is the bot's
  // own isolated login the sandboxed lark-cli is allowed to use.
  const sharedLarkStore = join(homedir(), '.lark-cli');
  if (existsSync(sharedLarkStore)) out.add(sharedLarkStore);

  return [...out];
}
