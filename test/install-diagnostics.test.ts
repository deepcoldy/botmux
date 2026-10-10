import { describe, expect, it } from 'vitest';
import { checkNode, analyzeInstalls, type InstallProbeDeps } from '../src/utils/install-diagnostics.js';

describe('checkNode', () => {
  it('ok at/above the required major', () => {
    expect(checkNode('v22.21.1', 22)).toEqual({ version: 'v22.21.1', major: 22, required: 22, ok: true });
    expect(checkNode('v24.0.0', 22).ok).toBe(true);
  });
  it('not ok below the required major', () => {
    expect(checkNode('v20.11.0', 22).ok).toBe(false);
    expect(checkNode('garbage', 22)).toEqual({ version: 'garbage', major: 0, required: 22, ok: false });
  });
});

// Synthetic filesystem: a ~/.botmux shim pointing at a source checkout, and an
// npm-global symlink pointing at a node_modules cli.js.
const SHIM = '/root/.botmux/bin/botmux';
const SHIM_BODY = '#!/bin/sh\nexec node "/root/iserver/botmux/dist/cli.js" "$@"\n';
const NPM_BIN = '/root/.local/share/fnm/node-versions/v22/installation/bin/botmux';
const NPM_CLI = '/root/.local/share/fnm/node-versions/v22/installation/lib/node_modules/botmux/dist/cli.js';
const PNPM_BIN = '/root/.local/share/pnpm/botmux';
const PNPM_CLI = '/root/.local/share/pnpm/global/5/node_modules/.pnpm/botmux@3.2.1/node_modules/botmux/dist/cli.js';
const YARN_BIN = '/root/.yarn/bin/botmux';
const YARN_CLI = '/root/.config/yarn/global/node_modules/botmux/dist/cli.js';
const BUN_BIN = '/root/.bun/bin/botmux';
const BUN_CLI = '/root/.bun/install/global/node_modules/botmux/dist/cli.js';

function deps(over: Partial<InstallProbeDeps> = {}): InstallProbeDeps {
  return {
    readFile: (p) => (p === SHIM ? SHIM_BODY : null),       // npm bin reads as the real (large) cli.js → null here
    realpath: (p) => ({
      [NPM_BIN]: NPM_CLI,
      [PNPM_BIN]: PNPM_CLI,
      [YARN_BIN]: YARN_CLI,
      [BUN_BIN]: BUN_CLI,
    })[p] ?? p,
    isSourceCheckout: (root) => root === '/root/iserver/botmux',
    ...over,
  };
}

describe('analyzeInstalls', () => {
  it('single npm install → not multiple, classified npm-global', () => {
    const out = analyzeInstalls([NPM_BIN], deps());
    expect(out.multiple).toBe(false);
    expect(out.entries).toEqual([{ binPath: NPM_BIN, root: '/root/.local/share/fnm/node-versions/v22/installation/lib/node_modules/botmux', kind: 'npm-global' }]);
  });

  it.each([
    [PNPM_BIN, 'pnpm-global'],
    [YARN_BIN, 'yarn-global'],
    [BUN_BIN, 'bun-global'],
  ] as const)('classifies %s by its owning global layout', (bin, kind) => {
    const out = analyzeInstalls([bin], deps());
    expect(out.multiple).toBe(false);
    expect(out.entries[0].kind).toBe(kind);
  });

  it('shim resolves to its source-checkout target', () => {
    const out = analyzeInstalls([SHIM], deps());
    expect(out.multiple).toBe(false);
    expect(out.entries).toEqual([{ binPath: SHIM, root: '/root/iserver/botmux', kind: 'source-checkout' }]);
  });

  it('shim + npm → multiple, both kinds surfaced', () => {
    const out = analyzeInstalls([SHIM, NPM_BIN], deps());
    expect(out.multiple).toBe(true);
    expect(out.entries.map(e => e.kind)).toEqual(['source-checkout', 'npm-global']);
  });

  it('dedups the same PATH entry listed twice', () => {
    const out = analyzeInstalls([SHIM, SHIM], deps());
    expect(out.entries).toHaveLength(1);
    expect(out.multiple).toBe(false);
  });

  it('dedups two bins that resolve to the same root', () => {
    const alt = '/usr/local/bin/botmux';
    const out = analyzeInstalls([SHIM, alt], deps({
      readFile: (p) => (p === SHIM || p === alt ? SHIM_BODY : null),
    }));
    expect(out.entries).toHaveLength(1);
    expect(out.multiple).toBe(false);
  });

  it('ignores blanks and unresolvable bins gracefully', () => {
    const out = analyzeInstalls(['', '  ', '/weird/botmux'], deps({
      readFile: () => null,
      realpath: () => null, // can't resolve → keyed by binPath, kind unknown
    }));
    expect(out.entries).toEqual([{ binPath: '/weird/botmux', root: '/weird/botmux', kind: 'unknown' }]);
    expect(out.multiple).toBe(false);
  });

  // ── Binary-era launchers (compiled platform binary, no cli.js anywhere) ─────
  // Since the main package gained a `bin` entry, ONE ordinary global install
  // puts TWO botmux on PATH: the launcher the package manager links, and the
  // ~/.botmux/bin shim postinstall writes. They exec the same binary, so they
  // are ONE install and must not be reported as a conflict.
  //
  // ⚠️ Neither form contains `cli.js`, so the cli.js scan cannot see them. This
  // is NOT a size-limit issue — measured with the size limit removed entirely,
  // both still resolved to null and `multiple` was true.
  const PKG = '/root/.local/share/fnm/node-versions/v22/installation/lib/node_modules/botmux';
  const PLATBIN = `${PKG}/node_modules/botmux-linux-x64/botmux`;
  const MGR_BIN = '/root/.local/share/fnm/node-versions/v22/installation/bin/botmux';
  const LAUNCHER = `${PKG}/scripts/botmux-launcher.sh`;
  const BIN_SHIM = '/root/.botmux/bin/botmux';
  const BIN_SHIM_BODY = `#!/bin/sh\nexec "${PLATBIN}" "$@"\n`;

  function binaryEraDeps(over: Partial<InstallProbeDeps> = {}): InstallProbeDeps {
    return {
      readFile: (p) => (p === BIN_SHIM ? BIN_SHIM_BODY : null),
      realpath: (p) => (p === MGR_BIN ? LAUNCHER : p),
      isSourceCheckout: () => false,
      ...over,
    };
  }

  it('one global install seen through BOTH its launcher and its shim is ONE install', () => {
    const out = analyzeInstalls([MGR_BIN, BIN_SHIM], binaryEraDeps());
    expect(out.entries).toHaveLength(1);
    expect(out.multiple).toBe(false);
    expect(out.entries[0].root).toBe(PKG);
    // Previously `unknown` for both: neither resolved, so neither got classified.
    expect(out.entries[0].kind).toBe('npm-global');
  });

  it('the package-manager launcher alone resolves to the package root', () => {
    const out = analyzeInstalls([MGR_BIN], binaryEraDeps());
    expect(out.entries).toEqual([{ binPath: MGR_BIN, root: PKG, kind: 'npm-global' }]);
  });

  it('the postinstall shim alone resolves to the package root via its exec target', () => {
    const out = analyzeInstalls([BIN_SHIM], binaryEraDeps());
    expect(out.entries).toEqual([{ binPath: BIN_SHIM, root: PKG, kind: 'npm-global' }]);
  });

  it('resolves the pnpm/bun sibling layout too, not just npm nesting', () => {
    const bunPkg = '/root/.bun/install/global/node_modules/botmux';
    const bunPlat = '/root/.bun/install/global/node_modules/botmux-linux-x64/botmux';
    const bunBin = '/root/.bun/bin/botmux';
    const out = analyzeInstalls([bunBin, BIN_SHIM], {
      readFile: (p) => (p === BIN_SHIM ? `#!/bin/sh\nexec "${bunPlat}" "$@"\n` : null),
      realpath: (p) => (p === bunBin ? `${bunPkg}/scripts/botmux-launcher.sh` : p),
      isSourceCheckout: () => false,
    });
    expect(out.entries).toHaveLength(1);
    expect(out.multiple).toBe(false);
    expect(out.entries[0].root).toBe(bunPkg);
  });

  it('still reports multiple when a global install and a source checkout coexist', () => {
    // The warning must keep firing for the case it exists for. Note SHIM and
    // BIN_SHIM are the same path — only one file can exist at ~/.botmux/bin/botmux
    // — so the real coexistence is: manager-linked launcher + a shim whose target
    // is a source checkout (what `bun run use:here` leaves behind).
    const out = analyzeInstalls([MGR_BIN, SHIM], binaryEraDeps({
      readFile: (p) => (p === SHIM ? SHIM_BODY : null),
      realpath: (p) => (p === MGR_BIN ? LAUNCHER : p),
      isSourceCheckout: (root) => root === '/root/iserver/botmux',
    }));
    expect(out.multiple).toBe(true);
    expect(out.entries.map(e => e.kind)).toEqual(['npm-global', 'source-checkout']);
  });

  it('does not match a bare "cli.js" literal inside a binary that slipped the size guard', () => {
    const out = analyzeInstalls(['/x/botmux'], deps({
      readFile: () => 'function x(){ return "cli.js"; }', // no path separator before cli.js
      realpath: (p) => p, // realpath is not a cli.js → unresolvable
    }));
    expect(out.entries[0].kind).toBe('unknown');
  });
});
