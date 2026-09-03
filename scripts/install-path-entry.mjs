/**
 * Put `~/.botmux/bin` on the user's PATH by writing their shell's startup file.
 *
 * WHY THIS EXISTS
 * `npm i -g botmux` has no `bin` field (removed with the Node fallback — see
 * postinstall-bin.mjs), so the ONLY `botmux` command is the launcher written to
 * `~/.botmux/bin/botmux`. If that directory is not on PATH, a successful install
 * still leaves the user with `botmux: command not found`.
 *
 * Both installers used to just PRINT a hint, and the hint was:
 *
 *     echo 'export PATH="…"' >> ~/.profile
 *
 * which is wrong for a large share of users, because **zsh never reads
 * `~/.profile`** (measured: `zsh -lic` on a home dir containing `.profile` reads
 * `.zshenv` + `.zprofile` + `.zshrc` and the `.profile` echo never fires). A zsh
 * user who followed the hint verbatim got a file that is silently ignored — the
 * command stayed missing with no indication why. That was the reported bug.
 *
 * ── WHICH FILE PER SHELL (all measured, not recalled) ─────────────────────────
 * Startup files actually sourced, by shell and invocation mode:
 *
 *   zsh   -c  → .zshenv
 *         -i  → .zshenv .zshrc
 *         -li → .zshenv .zprofile .zshrc
 *   bash  -c  → (none)
 *         -i  → .bashrc
 *         -li → the FIRST of .bash_profile → .bash_login → .profile
 *   fish      → ~/.config/fish/conf.d/*.fish in all three modes
 *
 * So the target per shell is the file that covers the most modes:
 *   • zsh  → ~/.zshenv                       (the only file read in all 3)
 *   • bash → ~/.bashrc AND its login file    (login vs interactive are disjoint)
 *   • fish → ~/.config/fish/conf.d/botmux.fish
 *
 * bash genuinely needs both: writing only `.bashrc` misses login shells, and
 * writing only the login file misses ordinary interactive ones.
 *
 * ⚠️ bash's login file is "the first that EXISTS", not always `.bash_profile` —
 * see bashLoginFile() below for why creating the wrong one destroys the user's
 * existing login config.
 *
 * ── fish SYNTAX ──────────────────────────────────────────────────────────────
 * fish is not POSIX; `export PATH="$INSTALL_DIR:$PATH"` is not its syntax. (fish
 * 3.6 happens to tolerate `export` as a compatibility shim and even produces a
 * correct PATH — measured — but `set -gx` is the real form and is what we write.)
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { basename } from 'node:path';

/** Marker so we can detect our own previous edit and never write twice. */
export const PATH_ENTRY_MARKER = '# added by botmux installer';

/**
 * Which shell is the user actually on? `$SHELL` is the login shell recorded in
 * passwd, which is what future terminals will start — the right question here,
 * and better than `process.ppid` guessing (the parent of a postinstall is npm,
 * not the user's shell).
 */
export function detectShell(env = process.env) {
  const shell = env.SHELL ?? '';
  const name = basename(shell);
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('fish')) return 'fish';
  if (name.includes('bash')) return 'bash';
  // Unknown or unset (containers, cron, exotic shells): POSIX `.profile` is the
  // most portable thing we can offer, and sh/ksh/dash all read it at login.
  return name ? 'other' : 'unknown';
}

/**
 * bash's LOGIN startup file, chosen without shadowing anything.
 *
 * ⚠️ bash reads only the FIRST of `.bash_profile` → `.bash_login` → `.profile`.
 * So creating `.bash_profile` on a machine whose login config lives in
 * `.profile` (or `.bash_login`) silently stops that file from ever being read.
 * Measured — a sentinel exported from `.profile` is visible to `bash -lic`, and
 * becomes MISSING the moment an unrelated `.bash_profile` appears; same for
 * `.bash_login`. That is destroying the user's environment to fix a PATH entry,
 * which is far worse than the bug being fixed.
 *
 * So: append to whichever of the three already exists (that is the file bash is
 * actually reading), and only fall back to CREATING `.bash_profile` when none of
 * them exists — in which case there is nothing to shadow.
 */
function bashLoginFile(home) {
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    const file = join(home, name);
    if (existsSync(file)) return file;
  }
  return join(home, '.bash_profile');
}

/**
 * Quote a path for literal use inside a shell startup file.
 *
 * ⚠️ SECURITY, not cosmetics. The install dir is caller-controlled
 * (`BOTMUX_INSTALL_DIR`, or just an unusual home), and the line we write is
 * EXECUTED by the user's shell on every startup. Interpolating it into double
 * quotes lets `$(…)`, backticks and `$VAR` run: measured — an install dir
 * containing `$(touch /tmp/PWNED)` created that file the first time zsh started,
 * and did so on every shell thereafter.
 *
 * Single quotes make the shell treat every byte literally; the only character
 * needing care is `'` itself, closed and re-opened via `'\''`. This form is
 * identical in POSIX shells and in fish.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The startup files to write for a shell, plus the line to write into each.
 * Returns [] when we have nothing safe to say.
 *
 * `env` is read for the two relocation variables below; both are honoured
 * because writing the un-relocated path produces a file the shell never reads —
 * the same class of bug as writing `.profile` for zsh.
 */
export function pathEntryTargets(shell, installDir, home = homedir(), env = process.env) {
  const q = shellQuote(installDir);
  // ⚠️ The STATEMENT has to be idempotent too, not just the file write. An
  // unconditional `export PATH=<dir>:$PATH` re-prepends on every shell startup, so
  // a nested or re-sourced shell keeps growing PATH — measured: the same directory
  // appeared twice at nesting depth 2, and `.bash_profile` files that source
  // `.bashrc` hit it within a single login. `case` is POSIX and quote-safe (no
  // subshell, no `grep`), and the `:` padding makes it an exact ELEMENT test, so a
  // sibling like `<dir>-old` never satisfies it.
  const posix = `case ":$PATH:" in *:${q}:*) ;; *) export PATH=${q}":$PATH" ;; esac  ${PATH_ENTRY_MARKER}`;
  switch (shell) {
    case 'zsh': {
      // ⚠️ zsh reads its dotfiles from $ZDOTDIR when that is set, falling back to
      // $HOME. Writing $HOME/.zshenv on a machine with ZDOTDIR set produces a file
      // zsh never reads — measured: `zsh -c botmux` → "command not found".
      const zdotdir = env.ZDOTDIR?.trim();
      const base = zdotdir ? zdotdir : home;
      return [{ file: join(base, '.zshenv'), line: posix }];
    }
    case 'bash': {
      // Disjoint coverage — see header. Both, or one of the two common ways of
      // opening a terminal is left broken. The login half must not shadow (above).
      const login = bashLoginFile(home);
      const targets = [{ file: join(home, '.bashrc'), line: posix }];
      // When bash's login file IS .bashrc-adjacent there is nothing more to add;
      // dedupe so we never append the same line to the same file twice.
      if (login !== join(home, '.bashrc')) targets.push({ file: login, line: posix });
      return targets;
    }
    case 'fish': {
      // ⚠️ fish's config dir is $XDG_CONFIG_HOME/fish, defaulting to ~/.config/fish.
      // Same failure as ZDOTDIR above — measured: with XDG_CONFIG_HOME set, a file
      // under ~/.config/fish is ignored, while the same line under
      // $XDG_CONFIG_HOME/fish/conf.d works (positive control).
      const xdg = env.XDG_CONFIG_HOME?.trim();
      const configHome = xdg ? xdg : join(home, '.config');
      return [{
        file: join(configHome, 'fish', 'conf.d', 'botmux.fish'),
        // fish: `contains` is its own exact list-element test — PATH is a real list
        // here, so no delimiter padding is needed.
        line: `contains ${q} $PATH; or set -gx PATH ${q} $PATH  ${PATH_ENTRY_MARKER}`,
      }];
    }
    case 'other':
    case 'unknown':
    default:
      return [{ file: join(home, '.profile'), line: posix }];
  }
}

/** Is `installDir` already handled by this file (ours or the user's own line)? */
export function fileAlreadyHasEntry(file, installDir) {
  if (!existsSync(file)) return false;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return false; }

  // ⚠️ TWO SEPARATE PREDICATES, deliberately not one clever one.
  //
  // Attempt #1 searched for the raw directory as a substring: `<installDir>-old`,
  // `/backup<installDir>` and `<installDir>/other` all counted as configured, so
  // the REAL directory was never written (measured, written=0 for each).
  // Attempt #2 split the line into tokens and compared them — but the line we
  // WRITE for a directory containing a quote is
  //     export PATH='/x/q'\''bin'":$PATH"
  // and ANY tokenizer that treats `'` as a separator shreds that into `/x/q`,
  // `\`, `bin`, so the quoted spelling can never match a token (measured: marker
  // count 1 → 2 on every re-install). Shell quoting cannot be undone by splitting
  // on characters.
  //
  // So: recognise OUR line by its own known syntax (marker + the exact quoted
  // form we would generate), and use conservative whole-token matching only for a
  // line the USER wrote by hand.
  const ourQuoted = shellQuote(installDir);
  const lines = text.split('\n').filter(l => !/^\s*#/.test(l));

  // (a) Our own line, byte-for-byte on the part that identifies the directory.
  //     `PATH=` + the exact quoted dir is enough; the suffix may legitimately
  //     differ (`":$PATH"` vs fish's ` $PATH`).
  if (lines.some(l => l.includes(PATH_ENTRY_MARKER) && l.includes(ourQuoted))) return true;

  // (b) A hand-written line. Compare whole PATH elements, and do NOT treat quotes
  //     as element separators — strip the wrapping quotes first, then split on the
  //     characters that actually delimit PATH elements.
  const PATH_ASSIGNMENT = new RegExp(
    [
      'export\\s+PATH\\s*=',      // POSIX: export PATH="…"
      '^\\s*PATH\\s*=',           // POSIX: PATH=…
      'set\\s+(-\\w+\\s+)*PATH',  // fish:  set -gx PATH …
      'fish_add_path',            // fish:  fish_add_path …
      '\\bpath\\+=',              // zsh:   path+=(…)
      '\\bpath=\\(',              // zsh:   path=(…)
    ].join('|'),
    'i',
  );
  const target = installDir.replace(/\/+$/, '');
  return lines.some(l => {
    if (!PATH_ASSIGNMENT.test(l)) return false;
    // Quotes here are shell syntax around a plain path (the quote-containing case
    // is handled by (a)); dropping them leaves the path bytes intact.
    const bare = l.replace(/["']/g, '');
    return bare
      .split(/[:\s()=]+/)
      .map(t => t.replace(/\/+$/, ''))
      .some(t => t !== '' && t === target);
  });
}

/**
 * Append the PATH line to every startup file the user's shell reads.
 *
 * Returns `{ written: string[], skipped: string[], failed: [{file, error}] }`.
 * Never throws: a PATH edit failing must not fail the install (the launcher is
 * already in place and the caller prints a manual fallback).
 */
export function ensurePathEntry(opts) {
  const installDir = opts.installDir;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const shell = opts.shell ?? detectShell(env);
  const targets = pathEntryTargets(shell, installDir, home, env);

  const written = [], skipped = [], failed = [];
  for (const { file, line } of targets) {
    if (fileAlreadyHasEntry(file, installDir)) { skipped.push(file); continue; }
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        // Keep the user's file intact; only append, and only with a leading
        // newline so we never glue onto an unterminated last line.
        const prev = readFileSync(file, 'utf8');
        appendFileSync(file, `${prev.endsWith('\n') || prev === '' ? '' : '\n'}${line}\n`);
      } else {
        writeFileSync(file, `${line}\n`);
      }
      written.push(file);
    } catch (err) {
      failed.push({ file, error: err && err.message ? err.message : String(err) });
    }
  }
  return { shell, written, skipped, failed };
}
