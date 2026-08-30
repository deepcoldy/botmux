import { describe, expect, it } from 'vitest';

import { isDeferredFromBunLeg, stripComments } from './helpers/bun-leg-selectors.js';

/**
 * Guards the selectors that decide which files the `bun test` leg may run.
 *
 * WHY THIS EXISTS: both directions of error are invisible in the runner's summary
 * line. Too narrow and files are SILENTLY SKIPPED while the population count still
 * looks healthy; too broad and files that would pass quietly sit out. This repo has
 * shipped that bug three times — a comment match, a bare `\binject\b` that deferred
 * 20 innocent files, and a name-based factory pattern that missed a callback spelled
 * `orig` — so the selectors need a two-sided guard of their own.
 *
 * It imports the REAL selector rather than re-declaring the patterns. An earlier
 * version copied them, which had two problems: the copy could drift, and the copied
 * literals made this very file match its own exclusion rule — so it was deferred out
 * of the leg it is supposed to guard, and only ever ran when invoked by hand. Passing
 * sources in as arguments keeps every example inside a parameter, where a scan of the
 * repository cannot see it.
 */

describe('bun leg selectors — files that must be deferred', () => {
  it.each([
    // The feature is defined by SHAPE — a factory that receives the original module —
    // not by what the parameter is called. All four syntactic forms must match.
    ['parenthesised arrow, conventional name', "vi.mock('./x.js', async (importOriginal) => ({}));"],
    ['parenthesised arrow, other name', "vi.mock('./x.js', async (orig) => ({}));"],
    ['parenless arrow (escaped a parens-only pattern)', "vi.mock('./x.js', async importOriginal => ({}));"],
    ['parenless arrow, other name', "vi.mock('./x.js', orig => ({}));"],
    ['function expression', "vi.mock('./x.js', function (orig) { return {}; });"],
    ['async function expression', "vi.mock('./x.js', async function (orig) { return {}; });"],
    ['no async keyword', "vi.mock('./x.js', (importOriginal) => ({}));"],
    // Module-registry / transform APIs, by name.
    ['vi.doMock', "vi.doMock('./x.js', () => ({}));"],
    ['vi.doUnmock', "vi.doUnmock('./x.js');"],
    ['vi.resetModules', 'vi.resetModules();'],
    ['vi.hoisted', 'const v = vi.hoisted(() => 1);'],
    // vitest's globalSetup→test channel, which bun:test does not export.
    ['a named import of inject from vitest', "import { it, inject } from 'vitest';"],
    ['inject from a vitest subpath', "import { inject } from 'vitest/suite';"],
    // An alias still pulls the export that does not exist, so the file still dies.
    ['inject imported under an alias', "import { inject as get } from 'vitest';"],
    // A mixed clause: the type specifier is erased, the value one is not.
    ['a value inject beside a type specifier', "import { type Mock, inject } from 'vitest';"],
  ])('defers: %s', (_label, source) => {
    expect(isDeferredFromBunLeg(source)).toBe(true);
  });
});

describe('bun leg selectors — files that must stay runnable', () => {
  it.each([
    // The supported form: a factory that does not ask for the original module.
    ['zero-argument factory', "vi.mock('./x.js', () => ({ a: 1 }));"],
    ['zero-argument async factory', "vi.mock('./x.js', async () => ({ a: 1 }));"],
    ['zero-argument function expression', "vi.mock('./x.js', function () { return {}; });"],
    ['bare vi.mock with no factory', "vi.mock('./x.js');"],
    // Ordinary callbacks must not be mistaken for a mock factory.
    ['an unrelated callback after a vi.mock', "vi.mock('./x.js');\narr.map((item) => item + 1);"],
    ['vi.fn with a parameter', 'const f = vi.fn((a) => a);'],
    ['spyOn mockImplementation', "vi.spyOn(o, 'm').mockImplementation((x) => x);"],
    ['mockImplementation after a bare vi.mock', "vi.mock('./x.js');\nthing.mockImplementation((v) => v);"],
    // Prose and identifiers must never decide whether a file runs.
    ['the word inject in a test title', "it('does not inject anything', () => {});"],
    ['a script name containing inject', "const s = 'inject-optional-binaries.mjs';"],
    ['a callback parameter named inject', 'register((inject) => inject());'],
    // Only vitest's `inject` is missing under bun. A same-named export from any other
    // module resolves normally, so deferring it would silently shrink the leg — the
    // exact failure this guard exists to catch. An import-clause-only pattern
    // deferred all three of these.
    ['inject from a local module', "import { inject } from './dependency-injection.js';"],
    ['inject from a DI package', "import { injectable, inject } from 'tsyringe';"],
    ['inject from a node builtin', "import { inject } from 'node:test';"],
    // `vitest-` is a different package; the specifier must match on a boundary.
    ['inject from a package merely prefixed vitest', "import { inject } from 'vitest-helpers';"],
    // Type-only imports are ERASED before execution, so the module never has to supply
    // the export. Verified under Bun 1.4: both forms run to completion even when
    // `vitest` cannot be resolved at runtime at all.
    ['a type-only import clause', "import type { inject } from 'vitest';"],
    ['an inline type specifier', "import { type inject } from 'vitest';"],
    ['type-only inject beside a value import', "import { type inject, describe } from 'vitest';"],
  ])('keeps runnable: %s', (_label, source) => {
    expect(isDeferredFromBunLeg(source)).toBe(false);
  });

  it('sees code that follows a template literal with a substitution', () => {
    // Regression: scanning a `${…}` substitution needs `reScanTemplateToken`, or the
    // `}` reads as a plain brace and the next backtick opens a NEW literal that
    // swallows the rest of the file. That blanked real calls and wrongly promoted
    // files into the leg — the defect is invisible unless the probe puts a template
    // BEFORE the thing being detected.
    const source = [
      'const p = (id: string) => join(DIR, `token-${id}.json`);',
      "vi.mock('node:fs', async (importOriginal) => ({}));",
    ].join('\n');
    expect(isDeferredFromBunLeg(source)).toBe(true);
  });

  it('still sees code after a plain template literal', () => {
    const source = ["const s = `no substitution`;", 'vi.resetModules();'].join('\n');
    expect(isDeferredFromBunLeg(source)).toBe(true);
  });

  it('ignores an unsupported API named only inside a comment', () => {
    expect(isDeferredFromBunLeg('// this file once used vi.resetModules\nit("x", () => {});')).toBe(false);
    expect(isDeferredFromBunLeg('/* vi.hoisted was removed */\nit("x", () => {});')).toBe(false);
  });

  it('strips comments but leaves code intact', () => {
    expect(stripComments('const a = 1; // trailing\nconst b = 2;')).toContain('const b = 2;');
    expect(stripComments('/* lead */ const c = 3;')).toContain('const c = 3;');
    // A URL must survive: the `//` there is not a comment.
    expect(stripComments("const u = 'https://example.com/x';")).toContain('https://example.com/x');
  });
});

describe('bun leg selectors — this guard runs inside the leg it guards', () => {
  it('is not deferred by its own rules', async () => {
    const { readFileSync } = await import('node:fs');
    // The earlier copy-the-patterns version excluded itself, so it never ran in CI.
    // Every example above lives in a function argument for exactly this reason.
    expect(isDeferredFromBunLeg(readFileSync('test/bun-runner-selectors.test.ts', 'utf8'))).toBe(false);
  });
});
