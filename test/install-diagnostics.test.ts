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

function deps(over: Partial<InstallProbeDeps> = {}): InstallProbeDeps {
  return {
    readFile: (p) => (p === SHIM ? SHIM_BODY : null),       // npm bin reads as the real (large) cli.js → null here
    realpath: (p) => (p === NPM_BIN ? NPM_CLI : p),
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

  it('does not match a bare "cli.js" literal inside a binary that slipped the size guard', () => {
    const out = analyzeInstalls(['/x/botmux'], deps({
      readFile: () => 'function x(){ return "cli.js"; }', // no path separator before cli.js
      realpath: (p) => p, // realpath is not a cli.js → unresolvable
    }));
    expect(out.entries[0].kind).toBe('unknown');
  });
});
