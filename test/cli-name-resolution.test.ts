import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_CLI_IDS, CLI_ALIASES, cliAliasesSelecting, rawCliExecutable, resolveCliName } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';

function aliasTable(extra: Partial<Record<CliId, readonly string[]>>): Record<CliId, readonly string[]> {
  return Object.fromEntries(ALL_CLI_IDS.map(id => [id, extra[id] ?? []])) as Record<CliId, readonly string[]>;
}

describe('resolveCliName', () => {
  it('accepts every cliId, ignoring case and surrounding spaces', () => {
    for (const id of ALL_CLI_IDS) {
      expect(resolveCliName(id)).toEqual({ kind: 'cli', cliId: id });
      expect(resolveCliName(` ${id.toUpperCase()} `)).toEqual({ kind: 'cli', cliId: id });
    }
  });

  it('resolves short aliases and program names, ignoring case', () => {
    expect(resolveCliName('cc')).toEqual({ kind: 'cli', cliId: 'claude-code' });
    expect(resolveCliName('Claude')).toEqual({ kind: 'cli', cliId: 'claude-code' });
    expect(resolveCliName('OMP')).toEqual({ kind: 'cli', cliId: 'oh-my-pi' });
  });

  it('accepts each CLI program name unless another CLI owns that name', () => {
    for (const id of ALL_CLI_IDS) {
      const program = rawCliExecutable(id);
      if (!program) continue;
      const name = basename(program);
      const resolved = resolveCliName(name);
      if (resolved.kind === 'ambiguous') {
        expect(resolved.candidates).toContain(id);
      } else if (resolved.kind === 'cli' && resolved.cliId !== id) {
        // codex-app runs codex, and the exact cliId wins.
        expect(ALL_CLI_IDS).toContain(name);
      } else {
        expect(resolved).toEqual({ kind: 'cli', cliId: id });
      }
    }
  });

  it('prefers an exact cliId over another CLI alias of the same name', () => {
    expect(resolveCliName('codex')).toEqual({ kind: 'cli', cliId: 'codex' });
    expect(resolveCliName('pi', aliasTable({ 'oh-my-pi': ['pi'] }))).toEqual({ kind: 'cli', cliId: 'pi' });
  });

  it('returns every candidate for an alias shared by several CLIs instead of picking one', () => {
    expect(resolveCliName('x', aliasTable({ pi: ['x'], codex: ['x'] }))).toEqual({ kind: 'ambiguous', candidates: ['codex', 'pi'] });
    expect(resolveCliName('TRAE')).toEqual({ kind: 'ambiguous', candidates: ['coco', 'traex'] });
  });

  it('reports unknown names, including empty input and retired CLIs', () => {
    for (const input of ['', '   ', 'does-not-exist', 'gemini', 'claude-code-x']) {
      expect(resolveCliName(input)).toEqual({ kind: 'unknown' });
    }
  });
});

describe('cliAliasesSelecting', () => {
  it('lists only the aliases that pick that CLI on their own', () => {
    expect(cliAliasesSelecting('claude-code')).toEqual(expect.arrayContaining(['claude', 'cc']));
    expect(cliAliasesSelecting('codex-app')).not.toContain('codex');
    expect(cliAliasesSelecting('traex')).not.toContain('trae');
    expect(cliAliasesSelecting('coco')).not.toContain('trae');
  });

  it('agrees with resolveCliName for every alias in the table', () => {
    for (const id of ALL_CLI_IDS) {
      for (const alias of CLI_ALIASES[id]) {
        const resolved = resolveCliName(alias);
        expect(cliAliasesSelecting(id).includes(alias)).toBe(resolved.kind === 'cli' && resolved.cliId === id);
      }
    }
  });
});
