/**
 * Scratch transport-credential enumeration.
 *
 * Scratch's threat model is integrity (host writes are COW-isolated), NOT
 * confidentiality: other people's tokens and login state stay readable (see
 * the user-token note below; lark-cli homes are not masked). The per-person
 * masks here only reduce exposure. The design does promise a "fixed credential
 * mask" for botmux's own transport secrets:
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
 * Files that don't exist are skipped. Per-person secret DIRECTORIES are masked
 * whether or not they exist yet: the overlay's lower layer is the live host, so
 * a directory (or a token file inside one) the daemon creates after spawn would
 * otherwise be readable inside a running session. A mask is a mount on the path
 * itself, so whatever later appears beneath it on the host stays hidden.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { resolveLarkCliLinuxStoreDir } from '../cli/fs-policy.js';
import { BACKGROUND_JOBS_HOME_ROOT } from '../../services/bytedcli-home.js';

export interface ScratchSecretInput {
  /** All botmux authority homes (~/.botmux + custom BOTMUX_HOME variants). */
  botmuxHomes: readonly string[];
  /** Session data dirs (webhook secrets + per-person tokens live here). */
  dataDirs: readonly string[];
  /** Resolved loaded BOTS_CONFIG path (may live outside any botmux home). */
  botsConfigPath?: string;
  /** OS user home, used to locate lark-cli keystores. Defaults to the real
   *  homedir(); probes/tests MUST pass an isolated temp home so enumeration
   *  never reads or writes the operator's real ~/.local/share/lark-cli. */
  homeDir?: string;
  /** Current session id, for the cli-identity per-session carve-out: the
   *  whole cli-identity/ directory is sealed (it holds every concurrent
   *  session's plaintext trigger-user tokens), but THIS session's own
   *  <sid>.<tool>.env/.bin/.turn files are returned as read-only carve paths
   *  (the governed CLI + `botmux send` need them). */
  sessionId?: string;
}

export interface ScratchSecrets {
  /** Paths denied read+write in the sandbox. */
  denyPaths: string[];
  /** Paths re-opened READ-ONLY inside an otherwise denied dir. */
  readOnlyCarvePaths: string[];
}

// Trigger-user CLI identity lives in ONE per-session directory
// cli-identity/<sid>.bin/ (wrapper scripts) which also holds the credentials
// under <sid>.bin/.data/<tool>.env + .data/turn (#1543 layout). Binding this
// single DIRECTORY read-only (rather than individual env files) both:
//  (a) seals every OTHER session's files (the cli-identity/ parent is denied),
//  (b) avoids the bwrap single-file inode pin — atomicWrite renames the env
//      files in place, and a directory bind resolves names live so a persistent
//      tmux pane reads the refreshed identity each turn.
const CLI_IDENTITY_DIR = 'cli-identity';
const PER_PERSON_SECRET_DIRS = ['vc-meeting-daemon-auth', 'bytedcli-home', 'oauth-pending'];
function sessionIdentityDirName(sessionId: string): string {
  return `${sessionId}.bin`;
}

function isFileOrLink(p: string): boolean {
  try { return !lstatSync(p).isDirectory(); } catch { return false; }
}
function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

export function enumerateScratchSecretPaths(input: ScratchSecretInput): ScratchSecrets {
  const out = new Set<string>();
  // Fixed host root: custom/core-only SESSION_DATA_DIR must not redirect the
  // mask away from detached jobs, including directories created after spawn.
  out.add(BACKGROUND_JOBS_HOME_ROOT);
  const readOnlyCarve = new Set<string>();
  const homeDir = input.homeDir || osHomedir();
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

  for (const dataDir of input.dataDirs) {
    // The fixed per-person dirs below are masked even when the data dir itself
    // does not exist yet: a custom SESSION_DATA_DIR leaves ~/.botmux/data to be
    // created by the first login, which may land mid-session.
    const dataDirExists = isDir(dataDir);
    // Webhook signing material in session data dirs.
    addFile(join(dataDir, 'webhook-master.key'));
    addFile(join(dataDir, 'webhook-secrets.json'));
    addFile(join(dataDir, 'feedback-webhook-secrets.json'));
    addFile(join(dataDir, 'master.key'));

    // Per-PERSON OAuth User Access Tokens. Named dynamically
    // (user-token-<appId>-<openId>.json, legacy user-token-<appId>.json /
    // user-token.json), so scan the data-dir top level by prefix rather than
    // a fixed list. Exposure reduction only: a token file created after spawn
    // is NOT masked, which is one reason scratch is not a credential boundary
    // (tokenStoreProtection counts only the allowlist sandbox).
    if (dataDirExists) {
      try {
        for (const name of readdirSync(dataDir)) {
          if (name === 'user-token.json' || name.startsWith('user-token-')) {
            addFile(join(dataDir, name));
          }
        }
      } catch { /* */ }
    }

    // Per-person secret subdirectories (whole dirs, present or not — see the
    // header): VC daemon auth tokens, each person's bytedcli login HOME and the
    // pending OAuth logins. The CLI never needs these inside a scratch turn
    // (they are daemon-side / per-owner).
    for (const secretDir of PER_PERSON_SECRET_DIRS) {
      const p = join(dataDir, secretDir);
      if (!isFileOrLink(p)) out.add(p);
    }

    // Trigger-user CLI identity dir: holds EVERY concurrent session's
    // plaintext user access tokens, one file set per session. Seal the whole
    // directory (so one scratch turn can't read another person's token), then
    // carve back READ-ONLY exactly this session's own files the governed CLI
    // / `botmux send` wrapper sources at runtime. Mirrors fs-policy's
    // per-session grants; never grant the parent.
    const cliIdentityDir = join(dataDir, CLI_IDENTITY_DIR);
    if (!isFileOrLink(cliIdentityDir)) {
      out.add(cliIdentityDir);
      if (input.sessionId) {
        const ownDir = join(cliIdentityDir, sessionIdentityDirName(input.sessionId));
        if (existsSync(ownDir)) readOnlyCarve.add(ownDir);
      }
    }
  }

  // Shared lark-cli keystore(s) holding every app's encrypted appsecret + the
  // master.key that decrypts them. On Linux the REAL store is
  // ~/.local/share/lark-cli (or $LARKSUITE_CLI_DATA_DIR/lark-cli) — NOT
  // ~/.lark-cli (a separate legacy form). Mask every form that exists; missing
  // ones are dropped. (macOS uses ~/Library/Application Support/lark-cli,
  // handled by the darwin module's authority-root seal.)
  const larkStoreCandidates = new Set<string>([
    join(homeDir, '.lark-cli'),
    resolveLarkCliLinuxStoreDir(process.env.LARKSUITE_CLI_DATA_DIR, homeDir),
  ]);
  for (const p of larkStoreCandidates) {
    if (existsSync(p)) out.add(p);
  }

  return { denyPaths: [...out], readOnlyCarvePaths: [...readOnlyCarve] };
}

/** Back-compat flat list (deny + ro-carve are all "secret-adjacent"); used by
 *  callers that only need the full denied set. */
export function enumerateScratchSecretPathList(input: ScratchSecretInput): string[] {
  return enumerateScratchSecretPaths(input).denyPaths;
}
