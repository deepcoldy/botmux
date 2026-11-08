/**
 * Evaluates the subset of GitHub Actions expressions our workflows use, so a
 * test can ask which jobs a workflow runs for an event instead of matching the
 * YAML text. Supported: literals, context property access, `!`, `==`, `!=`,
 * `&&`, `||`, parentheses and function calls. Anything else throws, so a
 * construct this evaluator does not know fails the test instead of being
 * silently misread.
 *
 * Semantics follow the Actions docs: `&&` / `||` yield an operand, not a
 * boolean; `==` is loose (strings compare case-insensitively, mismatched types
 * compare as numbers with null as 0); a missing property is null.
 */

type Token =
  | { kind: 'op'; text: string }
  | { kind: 'ident'; text: string }
  | { kind: 'literal'; value: unknown };

export type ExpressionFunctions = Record<string, (...args: unknown[]) => unknown>;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) { i += space[0].length; continue; }
    const op = /^(==|!=|&&|\|\||[!().,])/.exec(rest);
    if (op) { tokens.push({ kind: 'op', text: op[0] }); i += op[0].length; continue; }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) { tokens.push({ kind: 'literal', value: string[1].replace(/''/g, "'") }); i += string[0].length; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number) { tokens.push({ kind: 'literal', value: Number(number[0]) }); i += number[0].length; continue; }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (ident) {
      const word = ident[0];
      if (word === 'true' || word === 'false') tokens.push({ kind: 'literal', value: word === 'true' });
      else if (word === 'null') tokens.push({ kind: 'literal', value: null });
      else tokens.push({ kind: 'ident', text: word });
      i += word.length;
      continue;
    }
    throw new Error(`Unsupported expression syntax at "${rest}" in: ${source}`);
  }
  return tokens;
}

export function isTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === '' || Number.isNaN(value));
}

function asNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return NaN;
}

export function looseEquals(left: unknown, right: unknown): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return asNumber(a) === asNumber(b);
}

/** Evaluates one expression (no `${{ }}` wrapper) against `context`. */
export function evaluateExpression(
  source: string,
  context: Record<string, unknown>,
  functions: ExpressionFunctions = {},
): unknown {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (text: string) => tokens[pos]?.kind === 'op' && (tokens[pos] as { text: string }).text === text;
  const expect = (text: string) => {
    if (!peek(text)) throw new Error(`Expected "${text}" in: ${source}`);
    pos++;
  };

  const or = (): unknown => {
    let value = and();
    while (peek('||')) { pos++; const right = and(); value = isTruthy(value) ? value : right; }
    return value;
  };
  const and = (): unknown => {
    let value = equality();
    while (peek('&&')) { pos++; const right = equality(); value = isTruthy(value) ? right : value; }
    return value;
  };
  const equality = (): unknown => {
    let value = unary();
    while (peek('==') || peek('!=')) {
      const negate = peek('!=');
      pos++;
      const equal = looseEquals(value, unary());
      value = negate ? !equal : equal;
    }
    return value;
  };
  const unary = (): unknown => {
    if (peek('!')) { pos++; return !isTruthy(unary()); }
    return postfix();
  };
  const postfix = (): unknown => {
    let value = primary();
    while (peek('.')) {
      pos++;
      const name = tokens[pos++];
      if (name?.kind !== 'ident') throw new Error(`Expected a property name in: ${source}`);
      value = value !== null && typeof value === 'object' ? ((value as Record<string, unknown>)[name.text] ?? null) : null;
    }
    return value;
  };
  const primary = (): unknown => {
    const token = tokens[pos++];
    if (!token) throw new Error(`Unexpected end of: ${source}`);
    if (token.kind === 'literal') return token.value;
    if (token.kind === 'op') {
      if (token.text !== '(') throw new Error(`Unexpected "${token.text}" in: ${source}`);
      const value = or();
      expect(')');
      return value;
    }
    if (peek('(')) {
      pos++;
      const args: unknown[] = [];
      if (!peek(')')) {
        args.push(or());
        while (peek(',')) { pos++; args.push(or()); }
      }
      expect(')');
      const fn = functions[token.text.toLowerCase()];
      if (!fn) throw new Error(`Unsupported function ${token.text}() in: ${source}`);
      return fn(...args);
    }
    if (!(token.text in context)) throw new Error(`Unknown context "${token.text}" in: ${source}`);
    return context[token.text] ?? null;
  };

  const value = or();
  if (pos !== tokens.length) throw new Error(`Unexpected trailing tokens in: ${source}`);
  return value;
}

/** `format('pr-{0}', 7)` as Actions implements it. */
export function format(template: unknown, ...args: unknown[]): string {
  return String(template).replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index: string | undefined) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    return toText(args[Number(index)]);
  });
}

function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Expands every `${{ … }}` in a workflow string value. */
export function interpolate(template: string, context: Record<string, unknown>, functions: ExpressionFunctions = {}): string {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source: string) => toText(evaluateExpression(source, context, functions)));
}
