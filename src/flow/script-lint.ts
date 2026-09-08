/**
 * 脚本静态检查（设计文档 §10）。**这是 lint，不是边界**：负责让诚实脚本早报错，
 * 正确性来自 ctx 规则、意图持久化、写即核对与诚实恢复语义。
 *
 * 拒绝：`import`/`export`（唯一的 `export default` 除外）、`require(`、`process`、`globalThis`、
 * `eval`、`Function(`、`Date`、`performance`、`Math.random`、`fetch(`、`setTimeout`/`setInterval`/
 * `setImmediate`/`queueMicrotask`、`SharedArrayBuffer`/`Atomics`/`FinalizationRegistry`/`WeakRef`、
 * `Promise.all`/`allSettled`/`race`/`any`、`.then(`。
 *
 * 检查前先剥掉注释与字符串字面量（含模板字符串的静态部分；`${}` 内的代码保留），
 * 免得 prompt 文本里的「setTimeout」被误伤。
 */

export interface LintIssue {
  line: number;
  column: number;
  rule: string;
  message: string;
}

export class ScriptLintError extends Error {
  constructor(readonly issues: LintIssue[]) {
    super(`script rejected by static check:\n${issues.map((i) => `  ${i.line}:${i.column} ${i.rule}: ${i.message}`).join('\n')}`);
    this.name = 'ScriptLintError';
  }
}

interface Rule {
  rule: string;
  re: RegExp;
  message: string;
}

/**
 * 自由标识符规则：前面不能是 `.`（成员访问 `ctx.state.process` 是合法的成员名）或标识符字符。
 * 正则第 1 组是前导字符，报告位置要跳过它。
 */
const FREE = '(^|[^\\w$.])';
const IDENT_RULES: Rule[] = [
  { rule: 'no-require', re: new RegExp(`${FREE}require\\s*\\(`, 'g'), message: 'require() is not available; scripts import nothing' },
  { rule: 'no-process', re: new RegExp(`${FREE}process\\b`, 'g'), message: 'process is not available in scripts' },
  { rule: 'no-globalThis', re: new RegExp(`${FREE}globalThis\\b`, 'g'), message: 'globalThis is not available in scripts' },
  { rule: 'no-eval', re: new RegExp(`${FREE}eval\\s*\\(`, 'g'), message: 'eval() is not allowed' },
  { rule: 'no-function-ctor', re: new RegExp(`${FREE}Function\\s*\\(`, 'g'), message: 'Function() is not allowed' },
  { rule: 'no-date', re: new RegExp(`${FREE}Date\\b`, 'g'), message: 'Date makes replay nondeterministic; take timestamps from agent output instead' },
  { rule: 'no-performance', re: new RegExp(`${FREE}performance\\b`, 'g'), message: 'performance is not available in scripts' },
  { rule: 'no-random', re: new RegExp(`${FREE}Math\\s*\\.\\s*random\\b`, 'g'), message: 'Math.random makes replay nondeterministic' },
  { rule: 'no-fetch', re: new RegExp(`${FREE}fetch\\s*\\(`, 'g'), message: 'fetch() is not available; do I/O through agents' },
  { rule: 'no-timers', re: new RegExp(`${FREE}(?:setTimeout|setInterval|setImmediate|queueMicrotask)\\b`, 'g'), message: 'timers are not available; only ctx calls may wait' },
  { rule: 'no-shared-memory', re: new RegExp(`${FREE}(?:SharedArrayBuffer|Atomics|FinalizationRegistry|WeakRef)\\b`, 'g'), message: 'self-waking or nondeterministic builtins are removed from the script global' },
  { rule: 'no-promise-combinators', re: new RegExp(`${FREE}Promise\\s*\\.\\s*(?:all|allSettled|race|any)\\b`, 'g'), message: 'use ctx.parallel / ctx.pipeline; bare Promise combinators hide concurrency from position identity' },
  // `.then(` 本身就是成员调用，不用 FREE
  { rule: 'no-then', re: /()\.\s*then\s*\(/g, message: 'use await; .then() chains hide the ctx lifecycle from the host' },
];

/**
 * 把注释与字符串字面量替换成等长空白（保留换行以便定位）。模板字符串里的 `${…}` 表达式保留，
 * 表达式内可以再嵌套字符串、注释与模板。不是完整的 JS 词法器：正则字面量按普通代码处理
 * （`/.then(/` 这种极端写法会误报，可接受）。
 */
export function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(source[k] === '\n' ? '\n' : ' ');
  };

  const quoted = (quote: string): void => {
    out.push(quote);
    let j = i + 1;
    while (j < n && source[j] !== quote && source[j] !== '\n') {
      if (source[j] === '\\') j++;
      j++;
    }
    blank(i + 1, Math.min(j, n));
    if (j < n && source[j] === quote) {
      out.push(quote);
      j++;
    }
    i = j;
  };

  const template = (): void => {
    out.push('`');
    i++;
    while (i < n) {
      const ch = source[i]!;
      if (ch === '\\') {
        blank(i, Math.min(i + 2, n));
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push('`');
        i++;
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        out.push('${');
        i += 2;
        code(true);
        if (i < n) {
          out.push('}');
          i++;
        }
        continue;
      }
      out.push(ch === '\n' ? '\n' : ' ');
      i++;
    }
  };

  /** 消费代码直到 EOF；`untilBrace` 时在深度 0 的 `}` 前停下（不消费）。 */
  const code = (untilBrace: boolean): void => {
    let depth = 0;
    while (i < n) {
      const ch = source[i]!;
      const next = source[i + 1];
      if (ch === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quoted(ch);
        continue;
      }
      if (ch === '`') {
        template();
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (untilBrace && depth === 0) return;
        depth--;
      }
      out.push(ch);
      i++;
    }
  };

  code(false);
  return out.join('');
}

function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { line, column: index - last + 1 };
}

export function lintScript(source: string): LintIssue[] {
  const code = stripCommentsAndStrings(source);
  const issues: LintIssue[] = [];
  const push = (index: number, rule: string, message: string) => {
    const { line, column } = positionOf(code, index);
    issues.push({ line, column, rule, message });
  };

  const importRe = /(^|[^\w$.])import\b/g;
  for (let m = importRe.exec(code); m; m = importRe.exec(code)) {
    push(m.index + m[1]!.length, 'no-import', 'scripts import nothing; everything comes from ctx');
  }
  const exportRe = /(^|[^\w$.])export\b/g;
  let defaultExports = 0;
  for (let m = exportRe.exec(code); m; m = exportRe.exec(code)) {
    const at = m.index + m[1]!.length;
    const rest = code.slice(at + 'export'.length, at + 'export'.length + 16);
    if (/^\s+default\b/.test(rest)) {
      defaultExports++;
      if (defaultExports > 1) push(at, 'single-default-export', 'only one export default is allowed');
    } else {
      push(at, 'no-named-export', 'only `export default` is allowed');
    }
  }
  if (defaultExports === 0) {
    issues.push({ line: 1, column: 1, rule: 'missing-default-export', message: 'script must `export default` an async function (ctx) => …' });
  }

  for (const rule of IDENT_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(code); m; m = rule.re.exec(code)) {
      push(m.index + (m[1]?.length ?? 0), rule.rule, rule.message);
    }
  }
  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return issues;
}

export function assertScriptLint(source: string): void {
  const issues = lintScript(source);
  if (issues.length > 0) throw new ScriptLintError(issues);
}

/**
 * 把 `export default …` 改写成对宿主提供对象的赋值，脚本就能在 `vm` 里当普通脚本跑
 * （§10：vm context 不支持 ESM 模块）。lint 已保证恰好一个 default export 且没有别的 import/export。
 * 只替换关键字本身，源码其它字节原样保留，行号不变。
 */
export function transformDefaultExport(source: string, targetExpr: string): string {
  const code = stripCommentsAndStrings(source);
  const m = /(^|[^\w$.])export\s+default\b/.exec(code);
  if (!m) throw new Error('script has no export default');
  const at = m.index + m[1]!.length;
  const end = at + (m[0].length - m[1]!.length);
  return `${source.slice(0, at)}${targetExpr} =${source.slice(end)}`;
}
