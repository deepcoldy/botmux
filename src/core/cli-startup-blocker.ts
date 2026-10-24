/**
 * Recognize screens on which a freshly spawned CLI is waiting for a HUMAN
 * before it will open its composer: folder-trust confirmation, sign-in,
 * update/terms acceptance. Botmux cannot answer these from Lark, and a CLI
 * stuck on one never reaches its readyPattern — until now the only visible
 * symptom was a generic "transcript never showed this turn" notice.
 *
 * Pure: the worker passes its authoritative viewport text while the CLI is
 * still in its startup window and has never been input-ready, and turns a hit
 * into a specific thread notice (and holds queued input so it is never typed
 * into the dialog). Each rule needs the question AND the dialog's own option /
 * status lines, so prose that merely quotes a question does not match.
 *
 * Rules are keyed by exact on-screen text of a known build. When a CLI changes
 * its wording the rule simply stops matching and the worker falls back to the
 * generic "never became input-ready" wording — never a wrong specific claim.
 */

export type CliStartupBlockerKind = 'folder_trust' | 'login' | 'update' | 'terms';

export interface CliStartupBlocker {
  kind: CliStartupBlockerKind;
  /** Stable id of the rule that matched (logs / tests). */
  rule: string;
  /** Folder the trust question is about, when the dialog shows one. */
  folder?: string;
}

interface StartupBlockerRule {
  rule: string;
  kind: CliStartupBlockerKind;
  /** Every pattern must match somewhere on the screen. */
  all: readonly RegExp[];
  /** Pattern whose line is followed by the folder path, when shown. */
  folderAfter?: RegExp;
}

const RULES: readonly StartupBlockerRule[] = [
  {
    // Grok Build ≥1.0.64 (captured on 1.0.67 / 1.0.70):
    //   Do you trust the contents of this directory?
    //   /root/ec-apply-access
    //   Grok Build may run or modify contents in this directory,
    //   posing security risks.
    //   Yes, proceed   y
    //   No, quit       n
    rule: 'grok-folder-trust',
    kind: 'folder_trust',
    all: [
      /Do you trust the contents of this directory\?/,
      /^\s*(?:❯\s*)?Yes, proceed\b/m,
      /^\s*(?:❯\s*)?No, quit\b/m,
    ],
    folderAfter: /Do you trust the contents of this directory\?/,
  },
  {
    // Gemini CLI 0.65.0 (captured). Not auto-accepted by the worker's trust
    // fallback; `--skip-trust` would pre-answer it but older builds reject it.
    rule: 'gemini-folder-trust',
    kind: 'folder_trust',
    all: [/Do you trust the files in this folder\?/, /Trust folder \(/, /Don't trust/],
  },
  {
    // Claude Code 2.1.x / Seed / Genius (wording in the 2.1.310 binary). The
    // worker's TRUST_DIALOG_PATTERN normally accepts it within a second; this
    // only reports one that is still up at the first-prompt timeout.
    rule: 'claude-folder-trust',
    kind: 'folder_trust',
    all: [/Quick safety check: Is this a project you created or one you trust\?/, /Yes, I trust this folder/],
  },
  {
    // Antigravity agy 1.4.6 (binary strings).
    rule: 'antigravity-folder-trust',
    kind: 'folder_trust',
    all: [/Trust this folder\?/, /Yes, I trust this folder/],
  },
  {
    // Cursor Agent 2026.09 (binary strings; Botmux passes --trust).
    rule: 'cursor-workspace-trust',
    kind: 'folder_trust',
    all: [/Workspace Trust Required/, /Trust this workspace/],
  },
  {
    // TraeX / CoCo 0.211 and Codex ≥0.156 (binary strings). Same codex_core
    // dialog family; the worker auto-accepts "Yes, continue" / "Trust and continue".
    rule: 'codex-family-folder-trust',
    kind: 'folder_trust',
    all: [/Do you trust the contents of this directory\?/, /Yes, continue|Trust and continue/],
  },
  {
    // Pi 1.3.0, only when the project carries its own .pi config (binary strings).
    rule: 'pi-project-trust',
    kind: 'folder_trust',
    all: [/Trust project folder\?/, /Do not trust/],
  },
  {
    // Grok Build 1.0.70 device sign-in (no auth.json / expired session).
    rule: 'grok-browser-sign-in',
    kind: 'login',
    all: [
      /Approve in your browser to finish signing in\./,
      /Waiting for approval/,
    ],
  },
  {
    // Gemini CLI 0.65.0 (captured).
    rule: 'gemini-auth-method',
    kind: 'login',
    all: [/How would you like to authenticate for this project\?/, /Use Gemini API Key|Sign in with Google/],
  },
  {
    // Claude Code 2.1.310 (binary strings).
    rule: 'claude-login-method',
    kind: 'login',
    all: [/Select login method:/, /Claude account with subscription/],
  },
  {
    // Codex 0.162 (binary strings).
    rule: 'codex-sign-in',
    kind: 'login',
    all: [/Sign in with ChatGPT/, /Provide your own API key/],
  },
  {
    // TraeX / CoCo 0.211 (binary strings).
    rule: 'traex-sign-in',
    kind: 'login',
    all: [/Welcome to TRAE CLI/, /Sign in with a Personal Access Token/],
  },
  {
    // Cursor Agent: any key starts a browser login, so never type into it.
    rule: 'cursor-press-any-key-login',
    kind: 'login',
    all: [/Press any key to log in\.\.\./],
  },
  {
    // Kimi Code 0.31 pre-TUI update picker; Enter installs and exits.
    rule: 'kimi-update-picker',
    kind: 'update',
    all: [/Kimi Code Update Available/, /Install update now/, /Continue with current version/],
  },
  {
    // Codex / TraeX startup update prompt (binary strings).
    rule: 'codex-family-update-prompt',
    kind: 'update',
    all: [/Update available!/, /Skip until next version/],
  },
  {
    // MTR 0.4 (opencode fork) modal update dialog (binary strings).
    rule: 'mtr-update-dialog',
    kind: 'update',
    all: [/is available\. Would you like to update now\?/],
  },
  {
    // Claude Code bypass-permissions acceptance (2.1.310 binary strings); the
    // adapter pre-answers it, this reports a build where that stopped working.
    rule: 'claude-bypass-permissions-accept',
    kind: 'terms',
    all: [/Bypass Permissions mode/, /Yes, I accept/],
  },
];

const PATH_LINE = /^\s*((?:~|\/|[A-Za-z]:[\\/])[^\s].*?)\s*$/;

function folderAfter(screen: string, anchor: RegExp): string | undefined {
  const lines = screen.split(/\r?\n/);
  const at = lines.findIndex(line => anchor.test(line));
  if (at < 0) return undefined;
  for (const line of lines.slice(at + 1, at + 4)) {
    if (!line.trim()) continue;
    const m = PATH_LINE.exec(line);
    return m ? m[1] : undefined;
  }
  return undefined;
}

export function detectCliStartupBlocker(screen: string): CliStartupBlocker | null {
  if (!screen) return null;
  for (const rule of RULES) {
    if (!rule.all.every(pattern => pattern.test(screen))) continue;
    const folder = rule.folderAfter ? folderAfter(screen, rule.folderAfter) : undefined;
    return { kind: rule.kind, rule: rule.rule, ...(folder ? { folder } : {}) };
  }
  return null;
}

/** Identity of a blocker for "notify once" bookkeeping. */
export function startupBlockerKey(blocker: CliStartupBlocker): string {
  return `${blocker.kind}:${blocker.folder ?? ''}`;
}
