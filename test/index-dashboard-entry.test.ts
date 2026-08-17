import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Regression pins for the Dashboard's dedicated PM2 entry point.
 *
 * The Feishu H5 credential family (BOTMUX_DASHBOARD_FEISHU_H5_*, APP_SECRET
 * included) reaches the dashboard ONLY via index-dashboard.ts dotenv-loading
 * ~/.botmux/.env — deliberately NOT via the shared PM2 env block
 * (DAEMON_ENV_KEYS), which every bot daemon receives and which persists on
 * disk in ~/.botmux/ecosystem.config.json. Three things keep that channel
 * working, and each has a way to rot silently:
 *  1. cli.ts must start dist/index-dashboard.js, not dist/dashboard.js —
 *     pointed back at dashboard.js, the dashboard boots without dotenv and a
 *     fully configured H5 login is silently `enabled:false` (entry 404).
 *  2. index-dashboard.ts must dotenv BEFORE a DYNAMIC import of dashboard.js —
 *     made static, ESM hoisting evaluates dashboard.ts's import graph (incl.
 *     config.ts and its module-level process.env reads) before the entry's
 *     body, i.e. before dotenv ran.
 *  3. dashboard.ts must stay dotenv-free — a "convenient" dotenv at its top
 *     would still run AFTER its own static imports (config.ts included) and
 *     would re-create the broken half-loaded ordering in disguise.
 *
 * NOTE on depth: these are source-level pins, not a behavior-level boot test.
 * The honest behavior test would launch dist/index-dashboard.js as a child
 * process against a temp HOME/.env fixture — but importing dashboard.js starts
 * real HTTP/TCP servers, timers and daemon probes during module evaluation,
 * and the test would depend on a built dist/. Deliberate trade-off: pin the
 * exact mechanism (dotenv position + dynamic-import form + dotenv-free
 * dashboard.ts) at source level instead; the ESM evaluation-order semantics
 * they rely on are Node guarantees, not project code.
 */

const read = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

describe('index-dashboard.ts — Dashboard PM2 entry', () => {
  it('dotenv-loads ~/.botmux/.env BEFORE dynamically importing dashboard.js', () => {
    const src = read('index-dashboard.ts');
    const dotenvAt = src.indexOf('dotenvConfig(');
    const importAt = src.indexOf("await import('./dashboard.js')");
    expect(dotenvAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(dotenvAt);
  });

  it('uses the same .env path fallback as index-daemon.ts', () => {
    // One path contract for both managed cores: ~/.botmux/.env, falling back
    // to a cwd .env — an entry that resolved the file differently would split
    // daemon and dashboard onto different config sources.
    for (const rel of ['index-dashboard.ts', 'index-daemon.ts']) {
      const src = read(rel);
      expect(src, rel).toContain("join(homedir(), '.botmux', '.env')");
      expect(src, rel).toContain("existsSync(globalEnv) ? globalEnv : '.env'");
    }
  });

  it('contains no static import of ./dashboard.js (hoisting would defeat dotenv)', () => {
    const src = read('index-dashboard.ts');
    // Any static form is hoisted and evaluated before the entry body. Two
    // complementary patterns: the single-line one catches the bare side-effect
    // form (`import './dashboard.js'`), the `from` one catches default/named
    // forms even when the specifier list spans lines.
    expect(src).not.toMatch(/^\s*import\s+[^=\n]*['"]\.\/dashboard\.js['"]/m);
    expect(src).not.toMatch(/from\s+['"]\.\/dashboard\.js['"]/);
    expect(src).toContain("await import('./dashboard.js')");
  });

  it('statically imports nothing that would evaluate config.ts early', () => {
    // The entry may only lean on side-effect-free utils before dotenv runs.
    // A static './config.js' — or any './dashboard/...' module, whose imports
    // reach config.ts — would capture pre-dotenv process.env.
    const src = read('index-dashboard.ts');
    expect(src).not.toMatch(/^\s*import\s+[^=\n]*['"]\.\/config\.js['"]/m);
    expect(src).not.toMatch(/from\s+['"]\.\/config\.js['"]/);
    expect(src).not.toMatch(/^\s*import\s+[^=\n]*['"]\.\/dashboard\//m);
    expect(src).not.toMatch(/from\s+['"]\.\/dashboard\//);
  });

  it('dashboard.ts itself stays dotenv-free', () => {
    // Guards against someone "saving a file" by moving the dotenv call into
    // dashboard.ts: its own static imports (config.ts included) evaluate
    // before its first statement, so that dotenv would land too late — while
    // making the entry file LOOK redundant and safe to delete.
    expect(read('dashboard.ts')).not.toMatch(/dotenv/);
  });

  it('cli.ts points the botmux-dashboard PM2 app at dist/index-dashboard.js', () => {
    const cli = read('cli.ts');
    const appAt = cli.indexOf("name: 'botmux-dashboard'");
    expect(appAt).toBeGreaterThan(-1);
    // The script assignment sits inside the app object right after the name.
    const app = cli.slice(appAt, appAt + 1200);
    expect(app).toContain("join(PKG_ROOT, 'dist', 'index-dashboard.js')");
    expect(app).not.toContain("join(PKG_ROOT, 'dist', 'dashboard.js')");
  });
});
