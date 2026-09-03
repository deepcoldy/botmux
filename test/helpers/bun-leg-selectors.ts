/**
 * Which test files the `bun test` leg may run.
 *
 * Extracted from `scripts/run-bun-tests.mjs` so it can be imported by a guard
 * without executing a test run, and so the guard tests the REAL selector instead of
 * a hand-copied duplicate that can drift.
 *
 * The selectors are source-text patterns, not a parser. That is a deliberate
 * trade-off — a full AST pass would be more precise but needs the TypeScript
 * compiler in a path that runs before every leg — and it has a specific hazard
 * worth naming: **a file that merely mentions these names in prose or in a string
 * literal must not be excluded.** This repo has shipped that bug three times (a
 * comment match, a bare `\binject\b` that deferred 20 innocent files, and a
 * name-based factory pattern that missed a callback spelled `orig`), and each time
 * the population count looked perfectly healthy while files silently sat out.
 *
 * Hence two rules here:
 *   1. comments are stripped before matching, and
 *   2. this module carries NO example strings of its own — the guard that exercises
 *      it lives in `test/bun-runner-selectors.test.ts` and passes sources in as
 *      arguments, so the examples cannot feed back into a scan of the repo.
 */

/** APIs whose absence is a module-registry or transform gap, not a missing helper. */
const UNSUPPORTED_API = new RegExp(
  String.raw`\bvi\s*\.\s*(doMock|doUnmock|resetModules|hoisted)\b`
  // The `vi.mock` factory's original-module argument, referenced by its two
  // conventional names. Matching the SHAPE (below) is what actually decides; these
  // stay because a file can reference them without a factory call on the same line.
  + String.raw`|\bimportOriginal\b|\bimportActual\b`,
);

/**
 * `inject` is vitest's globalSetup→test channel and a NAMED EXPORT of `vitest`;
 * `bun test` resolves `vitest` to `bun:test`, which has no such export, so the file
 * dies at import. Detected by PARSING the import declarations (below) rather than by
 * a source-text pattern: a bare `\binject\b` matched test titles, script names and
 * callback parameters, and an import-clause-only pattern deferred every named
 * `inject` import regardless of the module it came from — measured: `import { inject }
 * from './dependency-injection.js'`, `'tsyringe'` and `'node:test'` were all excluded.
 * Only the `vitest` channel is unavailable under bun, so only it may defer a file.
 */
const VITEST_MODULE = /^vitest(\/|$)/;

/**
 * A `vi.mock` factory that TAKES the original-module argument, in every syntactic
 * form: parenthesised arrow, parenless arrow, and function expression. Bun never
 * supplies that argument, so any such factory fails regardless of the parameter's
 * name — which is why this is matched by shape. A zero-argument factory is the
 * supported form and must not match, so the parameter list has to be non-empty.
 */
const MOCK_FACTORY_TAKES_ORIGINAL = new RegExp(
  String.raw`\bvi\s*\.\s*mock\s*\([^,]+,\s*(?:async\s+)?(?:`
  + String.raw`\(\s*[A-Za-z_$][\w$]*`
  + String.raw`|function\s*[A-Za-z_$\w$]*\s*\(\s*[A-Za-z_$][\w$]*`
  + String.raw`|[A-Za-z_$][\w$]*\s*=>`
  + String.raw`)`,
);

/**
 * Remove comments so prose cannot decide whether a file runs.
 *
 * Deliberately simple: a `//` inside a string literal over-strips, which fails
 * CLOSED — the file stays in the leg and a real unsupported call there fails loudly
 * rather than being quietly dropped.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Load the TypeScript compiler, or throw.
 *
 * There is deliberately NO fallback to a regex-only path. That fallback existed and
 * looked safe — "literals stay visible, so a file is at worst deferred, never wrongly
 * promoted" — but a diff of both paths over all 1159 files showed it over-deferred
 * exactly ONE file: `test/bun-runner-selectors.test.ts`, the guard for these very
 * selectors, whose test inputs hold `importOriginal` / `inject` / parameterised
 * `vi.mock` as DATA. So the degraded path silently excluded the one file that would
 * have caught the degradation, and `loadDeferredSet` still exited 0.
 *
 * In a test-SELECTION context, over-deferring is not the safe side: it is a false-green
 * channel. Missing dependency ⟹ no trustworthy selection ⟹ stop the run.
 */
function loadTypeScript(): typeof import('typescript') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('typescript');
  } catch (err) {
    throw new Error(
      'bun-leg-selectors requires the `typescript` devDependency to decide which files '
      + 'the bun leg may run. Refusing to guess: a regex-only fallback silently deferred '
      + `this module's own guard. Original error: ${(err as Error)?.message ?? err}`,
    );
  }
}

/**
 * Every module specifier this source imports `binding` from AT RUNTIME.
 *
 * Text matching cannot do this job: `blankLiterals` blanks `'vitest'` along with every
 * other literal, so a pattern anchored on the specifier could never fire, and dropping
 * the anchor deferred any named `inject` import from any module.
 *
 * Type-only imports are EXCLUDED — both `import type { inject }` and the inline
 * `import { type inject }` form. They are erased before execution, so the module never
 * has to provide the export; verified under Bun 1.4, where both forms run to completion
 * against a `vitest` that cannot even be resolved at runtime. Counting them would defer
 * a file that runs perfectly well, which is the silent-shrink failure this module's
 * guard exists to prevent.
 */
function importedModulesWithNamedBinding(source: string, binding: string): string[] {
  const ts = loadTypeScript();
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    // `import type { … }` — the whole clause is erased.
    if (stmt.importClause?.isTypeOnly) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const hit = named.elements.some(el => {
      // `import { type inject }` — this one specifier is erased, siblings are not.
      if (el.isTypeOnly) return false;
      // `import { inject as x }` still pulls the unavailable export, so match the
      // PROPERTY name (what is imported) rather than the local alias.
      return (el.propertyName ?? el.name).text === binding;
    });
    if (hit) specifiers.push(stmt.moduleSpecifier.text);
  }
  return specifiers;
}

/**
 * Blank out string and template literals, keeping the source's length and line
 * structure so the patterns still see real code at real offsets.
 *
 * WHY: the patterns are source-text matches, so a file that merely holds an example
 * IN A STRING looks identical to one that calls the API. That is not hypothetical —
 * the guard for these very selectors excluded ITSELF, because its table of test
 * inputs contains a parameterised `vi.mock` factory as data. Scanning only real code
 * is what lets a file describe the unsupported forms without being deferred for it.
 *
 * Uses the TypeScript scanner rather than a regex: quotes nest, escape, and appear
 * inside template expressions, and a regex that tried to find "the end of a string"
 * would be wrong in exactly the cases that matter.
 */
function blankLiterals(source: string): string {
  const ts = loadTypeScript();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  const out: string[] = [];
  // Depth of `${ … }` substitutions we are inside, so the `}` that closes one can be
  // rescanned as the continuation of its template.
  let templateDepth = 0;
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    // ⚠️ A raw `scan()` treats the `}` closing a template substitution as an ordinary
    // brace, so the following backtick opens a NEW template instead of ending the old
    // one — measured: one 4205-character "literal" swallowed the rest of a 4881-byte
    // file, blanking real `vi.mock` calls and silently promoting two files that do use
    // a parameterised factory. `rescanTemplateToken` is the documented fix.
    if (token === ts.SyntaxKind.CloseBraceToken && templateDepth > 0) {
      token = scanner.reScanTemplateToken(/* isTaggedTemplate */ false);
    }
    if (token === ts.SyntaxKind.TemplateHead) templateDepth += 1;
    else if (token === ts.SyntaxKind.TemplateTail && templateDepth > 0) templateDepth -= 1;

    const text = scanner.getTokenText();
    const isBlankable = token === ts.SyntaxKind.StringLiteral
      || token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || token === ts.SyntaxKind.TemplateHead
      || token === ts.SyntaxKind.TemplateMiddle
      || token === ts.SyntaxKind.TemplateTail
      // Comments are blanked here rather than by a prior regex pass: stripping them
      // first left fragments that made the scanner mis-lex.
      || token === ts.SyntaxKind.SingleLineCommentTrivia
      || token === ts.SyntaxKind.MultiLineCommentTrivia;

    // Keep newlines so line-anchored patterns keep their meaning; blank the rest.
    out.push(isBlankable ? text.replace(/[^\n]/g, ' ') : text);
    token = scanner.scan();
  }
  return out.join('');
}

/** True when the bun leg cannot run this file and it must stay on vitest. */
export function isDeferredFromBunLeg(source: string): boolean {
  // Parsed, not text-matched: only `inject` FROM VITEST is unavailable under bun.
  const injectsFromVitest = importedModulesWithNamedBinding(source, 'inject')
    .some(spec => VITEST_MODULE.test(spec));
  if (injectsFromVitest) return true;

  const code = blankLiterals(source);
  return UNSUPPORTED_API.test(code) || MOCK_FACTORY_TAKES_ORIGINAL.test(code);
}
