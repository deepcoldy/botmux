/**
 * 找出「把仓库 src/ 源码当字符串读进来再断言」的测试用例。
 *
 * 这类用例钉的是实现文本：一改名或重构就红，代码还在但已经走不到时却照样绿。
 * 治理后只允许真正的结构护栏保留这种写法，而且用例（或外层 describe）上方必须有一行
 * `// 源码结构护栏(K1|K2|K3|K4)：<原因>` 注释（见 GUARD_MARKER）。规则说明见 CLAUDE.md「测试原则」。
 *
 * 判定是语法层面的：某个 it/test 回调体（包括它引用的模块级变量和函数）里出现了
 * readFileSync/readFile 调用，而且参数是落在仓库根下的 `src/` 路径。用 src 路径去
 * spawn、import 或执行代码不算；在临时目录里自建 `src/` 再读也不算。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export interface SourceTextRead {
  file: string;
  line: number;
  title: string;
  /** 用例或外层 describe 上方带有护栏标记注释。 */
  marked: boolean;
}

/**
 * 两种标注：`源码结构护栏(Kx)：…` 表示确属结构约束、只能读源码；
 * `非文本断言：…` 表示读的是 src 下的资源（HTML/CSS 等）拿去当夹具或交给浏览器，不对其文本做断言。
 */
export const GUARD_MARKER = /源码结构护栏\s*[（(]\s*K[1-4]|非文本断言\s*[：:]/;

const READ_CALLEE = /(^|\.)(readFileSync|readFile)$/;
const ITERATORS = /^(forEach|map|flatMap|filter|some|every|find|reduce)$/;
const TEST_CALLEE = /^(it|test)(\.(each|skip|only|concurrent|fails|skipIf|runIf|todo))?$/;
const SUITE_CALLEE = /^describe(\.(each|skip|only|concurrent|skipIf|runIf))?$/;
/** 字面量里出现 `src/...`、`../src/...`，或者作为 join 的一段单独出现 `'src'`。 */
const SRC_SEGMENT = /^(\.\.?\/)*src(\/|$)|(^|\/)\.\.\/src(\/|$)/;
/**
 * 把切出来的源码当代码执行（new Function / vm / transpileModule / eval）的写法。
 * 这类用例断言的是执行结果而不是文本，不算文本断言；不过它们依赖函数名和自由变量名，
 * 能导出被测函数时仍应直接 import。
 */
const EXECUTOR_CALLEE = /^(Function|eval|(\w+\.)?(transpileModule|runInNewContext|runInThisContext|runInContext|compileFunction)|(vm\.)?Script)$/;

/** 按语法判断：调用或 new 的目标是执行器。字符串、注释里出现的 `Function(` 不算。 */
const executesCache = new WeakMap<ts.Node, boolean>();
function executesCode(node: ts.Node): boolean {
  const cached = executesCache.get(node);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && EXECUTOR_CALLEE.test(n.expression.getText())) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  executesCache.set(node, found);
  return found;
}

/** 能把路径锚定到仓库根的写法。 */
const REPO_ANCHOR = /__dirname|import\.meta\.(url|dirname)|process\.cwd\(\)/;

function calleeName(call: ts.CallExpression): string {
  let expr: ts.Expression = call.expression;
  // it.each([...])('title', fn)：外层调用的 callee 本身又是一次调用。
  while (ts.isCallExpression(expr)) expr = expr.expression;
  return expr.getText();
}

/** src 路径片段：字面量里的 `src/…`、`../src/…`、单独的 `'src'`，以及模板插值之后的 `/src/…`。 */
function hasSrcPiece(node: ts.Node): boolean {
  if (stringPieces(node).some(piece => SRC_SEGMENT.test(piece) || piece === 'src')) return true;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isTemplateExpression(n) && n.templateSpans.some(span => /^\/src(\/|$)/.test(span.literal.text))) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function stringPieces(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const span of n.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function mentions(node: ts.Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const isDeclName = (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p)) && p.name === n;
      // `obj.style`、`{ style: … }`、`style() {}` 里的 style 是属性名，不是对变量的引用。
      const isPropName = (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)
        || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === n
        || (ts.isBindingElement(p) && p.propertyName === n);
      if (!isDeclName && !isPropName) { hit = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

const PATH_CALLEE = /(^|\.)(join|resolve|dirname|fileURLToPath|normalize)\w*$/i;
function isPathExpression(node: ts.Node): boolean {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return isPathExpression(node.expression);
  if (ts.isNewExpression(node)) return node.expression.getText() === 'URL';
  if (ts.isCallExpression(node)) return PATH_CALLEE.test(node.expression.getText());
  if (ts.isPropertyAccessExpression(node)) return /^import\.meta\.(dirname|url)$/.test(node.getText());
  if (ts.isIdentifier(node)) return node.text === '__dirname';
  return false;
}

function hasMarker(text: string, stmt: ts.Node): boolean {
  const ranges = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  return ranges.some(r => GUARD_MARKER.test(text.slice(r.pos, r.end)));
}

export function findSourceTextReads(file: string, text: string): SourceTextRead[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // 模块级（不在用例回调内）的声明：变量初始化式与函数体。
  const decls: Array<[string, ts.Node, 'var' | 'fn']> = [];
  // for (const rel of <src 路径的数组>) —— 循环变量就是 src 路径（在下面的迭代里判定）。
  const forOfs: Array<[string, ts.Expression]> = [];
  // 对象字面量里的方法（`{ read: (p) => readFileSync(…) }`、`{ read(p) { … } }`）。
  const methods: Array<[string, ts.Node]> = [];
  const collect = (n: ts.Node, inTest: boolean) => {
    if (ts.isCallExpression(n) && TEST_CALLEE.test(calleeName(n))) inTest = true;
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
      const decl = n.initializer.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) forOfs.push([decl.name.text, n.expression]);
    }
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) methods.push([n.name.text, n.initializer]);
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.body && ts.isObjectLiteralExpression(n.parent)) methods.push([n.name.text, n.body]);
    if (!inTest) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.push([n.name.text, n.initializer, 'var']);
      if (ts.isFunctionDeclaration(n) && n.name && n.body) decls.push([n.name.text, n.body, 'fn']);
    }
    ts.forEachChild(n, c => collect(c, inTest));
  };
  collect(sf, false);

  // 仓库根锚点变量（repoRoot = join(__dirname, '..') 之类）与指向 src 的路径变量。
  const anchors = new Set<string>();
  // 指向 src 的路径变量、src 路径数组，以及返回 src 路径的函数（`srcPath = f => join(ROOT, 'src', f)`）。
  const srcPaths = new Set<string>();
  // 读出来的源码文本，或者返回源码文本的函数。
  const sourceText = new Set<string>();
  // 按参数路径读文件的通用读取函数（`const read = (p) => readFileSync(join(ROOT, p))`）：
  // 调用处传入 src 路径字面量时，等同于直接读源码。
  const readers = new Map<string, Set<number>>();
  const methodReaders = new Map<string, Set<number>>();

  /** 读取函数的实参是否指向 src：src 路径变量，或自带 src 段的相对路径（不含 JSON 数据文件）。 */
  const isSrcArg = (arg: ts.Node): boolean => {
    if (stringPieces(arg).some(p => /\.json$/.test(p))) return false;
    if (mentions(arg, srcPaths)) return true;
    if (!hasSrcPiece(arg)) return false;
    if (ts.isStringLiteralLike(arg)) return true;
    // join('src', f) / resolve('src/x.ts')：第一段就是 src，没有别的基准目录（临时目录下自建的 src 不算）。
    const first = ts.isCallExpression(arg) && /(^|\.)(resolve|join)\w*$/i.test(arg.expression.getText()) ? arg.arguments[0] : undefined;
    return first !== undefined && ts.isStringLiteralLike(first) && (SRC_SEGMENT.test(first.text) || first.text === 'src');
  };

  const isRepoSrcPath = (expr: ts.Node): boolean => {
    const pieces = stringPieces(expr);
    // src 下的 JSON 是数据文件（例如 lark-scopes.json），读来当夹具不算钉实现文本。
    if (pieces.some(p => /\.json$/.test(p))) return false;
    if (hasSrcPiece(expr)) {
      const raw = expr.getText();
      // 纯相对字面量（'src/x.ts'、'../src/x.ts'）按 cwd / 测试文件解析，都落在仓库里。
      // resolve('src/x.ts') / join('src', 'x.ts') 也一样：第一段就是 src，没有别的基准目录。
      const firstArg = ts.isCallExpression(expr) && /(^|\.)(resolve|join)\w*$/i.test(expr.expression.getText()) ? expr.arguments[0] : undefined;
      const bareRelative = ts.isStringLiteralLike(expr)
        || (ts.isNewExpression(expr) && /^new URL\(\s*['"`]/.test(raw))
        || (firstArg !== undefined && ts.isStringLiteralLike(firstArg) && (SRC_SEGMENT.test(firstArg.text) || firstArg.text === 'src'));
      if (bareRelative || REPO_ANCHOR.test(raw) || mentions(expr, anchors)) return true;
    }
    return mentions(expr, srcPaths);
  };

  const readsSource = (node: ts.Node): boolean => {
    if (executesCode(node)) return false;
    // 回调体里同名的局部声明会遮蔽模块级变量，不能算作引用了源码文本。
    const shadowed = new Set<string>();
    const declare = (n: ts.Node) => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name)) shadowed.add(n.name.text);
      ts.forEachChild(n, declare);
    };
    if (node !== sf) ts.forEachChild(node, declare);
    const visible = new Set([...sourceText].filter(name => !shadowed.has(name)));
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (ts.isCallExpression(n) && READ_CALLEE.test(n.expression.getText()) && n.arguments[0] && isRepoSrcPath(n.arguments[0])) {
        hit = true;
        return;
      }
      // 只看流进读取的那个参数位置：同一个函数的其它参数里出现 src 路径（比如拿去 spawn）不算。
      const readIndexes = !ts.isCallExpression(n) ? undefined
        : ts.isIdentifier(n.expression) ? (shadowed.has(n.expression.text) ? undefined : readers.get(n.expression.text))
          : ts.isPropertyAccessExpression(n.expression) ? methodReaders.get(n.expression.name.text) : undefined;
      if (readIndexes && [...readIndexes].some(i => {
        const arg = (n as ts.CallExpression).arguments[i];
        return arg !== undefined && isSrcArg(arg);
      })) {
        hit = true;
        return;
      }
      // files.forEach(f => readFileSync(f))：遍历 src 路径数组时，回调形参就是 src 路径。
      const iterated = ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ITERATORS.test(n.expression.name.text) && isSrcCollection(n.expression.expression)
        ? n.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as ts.ArrowFunction | undefined
        : undefined;
      const added = iterated ? iterated.parameters.flatMap(p => ts.isIdentifier(p.name) && !srcPaths.has(p.name.text) ? [p.name.text] : []) : [];
      for (const name of added) srcPaths.add(name);
      ts.forEachChild(n, visit);
      for (const name of added) srcPaths.delete(name);
    };
    visit(node);
    return hit || mentions(node, visible);
  };

  /** src 路径的数组：字面量数组里有 src 路径，或者就是一个 src 路径数组变量。 */
  const isSrcCollection = (expr: ts.Node): boolean =>
    (ts.isArrayLiteralExpression(expr) && expr.elements.some(e => isRepoSrcPath(e))) || mentions(expr, srcPaths);

  /** 返回 src 路径的函数：箭头函数的表达式体或任一 return 是仓库 src 路径。 */
  const returnsSrcPath = (node: ts.Node): boolean => {
    const fn = ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node
      : ts.isBlock(node) && ts.isFunctionDeclaration(node.parent) ? node.parent : undefined;
    if (!fn?.body) return false;
    if (!ts.isBlock(fn.body)) return isRepoSrcPath(fn.body);
    let found = false;
    const visit = (n: ts.Node) => {
      if (found || ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression && isRepoSrcPath(n.expression)) { found = true; return; }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return found;
  };

  // 函数的读文件路径由它自己的某个形参决定（`read(rel)`、递归的 `walk(dir)`）。
  /** 返回流进读取路径的形参下标；不是读取函数时返回空集。 */
  const pathReaderParams = (node: ts.Node): Set<number> => {
    const fn = ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node
      : ts.isBlock(node) && (ts.isFunctionDeclaration(node.parent) || ts.isMethodDeclaration(node.parent)) ? node.parent : undefined;
    const indexes = new Set<number>();
    if (!fn) return indexes;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && READ_CALLEE.test(n.expression.getText()) && n.arguments[0]) {
        const arg = n.arguments[0];
        fn.parameters.forEach((param, i) => {
          if (!ts.isIdentifier(param.name)) return;
          // 读取路径由这个形参决定即可；是不是 src 由调用处传入的实参判断。
          if (mentions(arg, new Set([param.name.text]))) indexes.add(i);
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return indexes;
  };

  // 读取函数只取决于自身的形参，先算一次，不放进下面的迭代。
  const readerCandidates = new Map<ts.Node, Set<number>>();
  for (const [, init] of decls) {
    const indexes = pathReaderParams(init);
    if (indexes.size > 0) readerCandidates.set(init, indexes);
  }
  for (const [name, fn] of methods) {
    const indexes = pathReaderParams(fn);
    if (indexes.size > 0) methodReaders.set(name, new Set([...(methodReaders.get(name) ?? []), ...indexes]));
  }

  // 迭代到不动点：锚点 → 路径 → 文本，彼此可以层层引用。
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const [name, init, kind] of decls) {
      const raw = init.getText();
      // 只有「路径表达式」形状的变量才可能是锚点或 src 路径；函数体、spawn 调用等一律不算。
      if (kind === 'var' && isPathExpression(init) && !/readFileSync|readFile\b/.test(raw)) {
        if (!hasSrcPiece(init) && !anchors.has(name) && !srcPaths.has(name) && (REPO_ANCHOR.test(raw) || mentions(init, anchors))) {
          anchors.add(name); changed = true;
        }
        if (!srcPaths.has(name) && isRepoSrcPath(init)) { srcPaths.add(name); changed = true; }
      }
      if (kind === 'var' && !srcPaths.has(name) && ts.isArrayLiteralExpression(init) && isSrcCollection(init)) { srcPaths.add(name); changed = true; }
      if (!srcPaths.has(name) && !readerCandidates.has(init) && returnsSrcPath(init)) { srcPaths.add(name); changed = true; }
      if (!readers.has(name) && readerCandidates.has(init)) { readers.set(name, readerCandidates.get(init)!); changed = true; }
      if (!sourceText.has(name) && readsSource(init)) { sourceText.add(name); changed = true; }
    }
    for (const [name, expr] of forOfs) {
      if (!srcPaths.has(name) && (hasSrcPiece(expr) ? isSrcCollection(expr) || isRepoSrcPath(expr) : mentions(expr, srcPaths))) { srcPaths.add(name); changed = true; }
    }
    if (!changed) break;
  }

  const out: SourceTextRead[] = [];
  const visitTests = (n: ts.Node, suiteMarked: boolean) => {
    if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
      const call = n.expression;
      const name = calleeName(call);
      if (SUITE_CALLEE.test(name)) {
        const marked = suiteMarked || hasMarker(text, n);
        ts.forEachChild(call, c => visitTests(c, marked));
        return;
      }
      if (TEST_CALLEE.test(name)) {
        const body = call.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        // it.each(['src/a.ts', …])('…', file => …)：表里是 src 路径时，回调形参就是 src 路径。
        const eachTable = ts.isCallExpression(call.expression) ? call.expression.arguments : undefined;
        const eachParams = body && eachTable?.some(arg => isSrcCollection(arg) || hasSrcPiece(arg))
          ? (body as ts.ArrowFunction).parameters.flatMap(param => ts.isIdentifier(param.name) ? [param.name.text] : [])
          : [];
        for (const name of eachParams) srcPaths.add(name);
        const reads = body !== undefined && readsSource(body);
        for (const name of eachParams) srcPaths.delete(name);
        if (body && reads) {
          const titleArg = call.arguments[0];
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            title: titleArg && ts.isStringLiteralLike(titleArg) ? titleArg.text : (titleArg?.getText() ?? ''),
            marked: suiteMarked || hasMarker(text, n),
          });
        }
        return;
      }
    }
    ts.forEachChild(n, c => visitTests(c, suiteMarked));
  };
  visitTests(sf, false);
  return out;
}

/** 仓库里 unit 项目会跑到的测试文件（与 vitest.config.ts 的 unit include/exclude 一致）。 */
export function scanRepoTests(repoRoot: string): SourceTextRead[] {
  const out: SourceTextRead[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && relative(repoRoot, abs) !== join('test', 'e2e-browser')) walk(abs);
      } else if (/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.e2e.ts')) {
        const text = readFileSync(abs, 'utf8');
        // 便宜的预筛：不读文件的测试不用解析。
        if (text.includes('readFile')) out.push(...findSourceTextReads(relative(repoRoot, abs), text));
      }
    }
  };
  walk(join(repoRoot, 'test'));
  return out;
}
