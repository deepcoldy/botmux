/**
 * Long, regex-hostile inputs for the failure-text masking (maskFailureText)
 * and the screen tail around it: each is about 50 000 characters shaped to
 * make one rule backtrack — a run its name, flag or token pattern restarts
 * in, a quote or label that never closes, a long blank row, rows that keep
 * the wrapped-value rules busy. A rule that is quadratic over one of them
 * takes seconds; a linear one, milliseconds.
 */
export const PATHOLOGICAL_LENGTH = 50_000;

/** Per input: masking it must finish within this (a quadratic rule takes
 *  seconds at this length; the linear rules take a few milliseconds). */
export const PATHOLOGICAL_BOUND_MS = 200;

const N = PATHOLOGICAL_LENGTH;
const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
const blanks = ' '.repeat(N);

export const PATHOLOGICAL_TEXTS: ReadonlyArray<readonly [name: string, text: string]> = [
  // One character, a whole row of it.
  ...['?', '&', '=', ':', '：', '-', '_', '.', '"', "'", '`', '\\', '/', '@', '<', '{', '‹', '│', ' ', '\t', '\n', 'a']
    .map((c) => [`${JSON.stringify(c)} × ${N}`, fill(c)] as const),
  // Runs a name, a flag or a token pattern would restart in at every `-`.
  ['a-a-a-…', fill('a-')],
  ['token-token-…', fill('token-')],
  ['api-keyapi-key…', fill('api-key')],
  ['session-session-…', fill('session-')],
  ['key-key-…', fill('key-')],
  ['sig-sig-…', fill('sig-')],
  ['tokentoken… (one word)', fill('token')],
  ['eyJ-eyJ-… (no dot)', fill('eyJ-')],
  ['eyJaaaaaaaa.…', fill('eyJaaaaaaaa.')],
  ['sk-sk-…', fill('sk-')],
  ['ghp_… / AKIA…', fill('ghp_AKIA')],
  // Flags.
  ['--token --token …', fill('--token ')],
  [' -token -token…', fill(' -token')],
  ['--a--a…', fill('--a')],
  ['--app-secret, then blanks', `--app-secret${blanks}`],
  ['"--token", "--token", …', fill('"--token", ')],
  // Header and scheme rules.
  ['Bearer Bearer …', fill('Bearer ')],
  ['Basic Basic …', fill('Basic ')],
  ['authorization authorization …', fill('authorization ')],
  ['authorization: and blanks', `authorization:${blanks}`],
  ['cookie: a=b; a=b; …', `cookie: ${fill('a=b; ')}`],
  // URL userinfo and query values.
  ['//a:b:b:b… (no @)', `//a:${fill('b:')}`],
  ['//a//a//a…', fill('//a')],
  ['//a:b//a:b…', fill('//a:b')],
  ['?a?a?a…', fill('?a')],
  ['?a=?a=…', fill('?a=')],
  ['&a&a&a…', fill('&a')],
  ['? then a long name, no =', `?${'a'.repeat(N)}`],
  // Labels and quoted values that never close.
  ['password: "aaaa… (no closing quote)', `password: "${'a'.repeat(N)}`],
  ['password: "\\a\\a…', `password: "${fill('\\a')}`],
  ["token: 'a a a…", `token: '${fill('a ')}`],
  ['password, blanks, no separator', `password${blanks}x`],
  ['password: password: …', fill('password: ')],
  ['"password": "a"password": "a…', fill('"password": "a')],
  ['密码密码…', fill('密码')],
  ['密码：and blanks', `密码：${blanks}`],
  ['App Secret：App Secret：…', fill('App Secret：')],
  // Rows: a masked value above each row, open quotes, borders, blank rows.
  ['token=x rows', fill('token=x\n')],
  ['a masked value, then token-like rows', `token=x\n${fill('ABCD\n')}`],
  ['open-quote rows', fill('"password": "a\n')],
  ['an open quote, then a long bordered blank row', `"password": "abc\n│${blanks}x`],
  ['a masked value, then a long blank row', `token=abc\n${blanks}x`],
  ['box rows', fill('│ ABCDEFGH │\n')],
  ['a long blank row, then x', `${blanks}x`],
  ['│, a long blank run, x', `│${blanks}x`],
  ['blank rows', fill(' \n')],
  ['‹hidden› ‹hidden› …', fill('‹hidden› ')],
  // Escapes and paths.
  ['ESC[ ESC[ …', fill('\x1b[')],
  ['ESC] never terminated', `\x1b]${'a'.repeat(N)}`],
  ['ESC[ ;;;… never final', `\x1b[${';'.repeat(N)}`],
  ['/home//home/…', fill('/home/')],
  // Everything at once.
  ['mixed', fill('a?b&c=d "e" --f g: h │ token=x\n')],
];

/** The faster of two runs, in milliseconds (one GC pause is not the rule's cost). */
export function bestOfTwoMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}
