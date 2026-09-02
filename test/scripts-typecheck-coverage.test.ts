import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * scripts/ 的类型检查覆盖面守卫。
 *
 * 背景：`tsconfig.json` 只 include `src/**`，所以 scripts/ 下的验收脚本与浏览器夹具
 * **从来没被 tsc 看过**。它们直接 import 生产模块，生产侧改了类型契约时脚本这边毫无
 * 反应，只会表现成「脚本跑绿了，但验的是旧契约」——批 1、批 2 各真实踩过一次：夹具的
 * `SessionPreviewTarget` 少了 owner/workerGeneration、注入的 location 少了
 * protocol/hostname，脚本照样 exit 0。
 *
 * 这份测试盯的是那条根因修复本身能不能被悄悄拆掉：
 *   ① `tsconfig.scripts.json` 解析出来的**文件集合**必须真的覆盖磁盘上每一个
 *      `scripts/**\/*.ts(x)`（光断言 include 字符串没用——exclude 或 files 一样能把
 *      文件踢出程序）；
 *   ② 它必须继承生产那套 strict 规则、且不产出编译结果；
 *   ③ `bun run build` 必须真的跑这一步，否则 CI 上这道门等于不存在。
 */

const repoRoot = process.cwd();
const scriptsDir = join(repoRoot, 'scripts');
const configPath = join(repoRoot, 'tsconfig.scripts.json');

/** 磁盘上所有会被 tsc 处理的脚本源文件（含 fixtures 子目录）。 */
function scriptSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...scriptSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parsedScriptsConfig(): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configPath, path => readFileSync(path, 'utf8'));
  expect(read.error, `tsconfig.scripts.json 读不出来：${JSON.stringify(read.error)}`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);
  expect(parsed.errors.filter(error => error.category === ts.DiagnosticCategory.Error)).toEqual([]);
  return parsed;
}

describe('scripts/ 纳入类型检查', () => {
  it('tsconfig.scripts.json 的程序覆盖每一个 scripts 源文件', () => {
    const parsed = parsedScriptsConfig();
    const covered = new Set(parsed.fileNames.map(file => relative(repoRoot, file)));
    const onDisk = scriptSourceFiles(scriptsDir).map(file => relative(repoRoot, file));

    expect(onDisk.length).toBeGreaterThan(10);
    // 夹具是最容易漂移的那一类，单独点名一次：它渲染的是生产组件。
    expect(onDisk).toContain(join('scripts', 'fixtures', 'agent-workbench-browser.tsx'));

    const missing = onDisk.filter(file => !covered.has(file));
    expect(missing, `这些脚本没进类型检查程序：${missing.join(', ')}`).toEqual([]);
    // 只该覆盖 scripts/，不该顺手把 src/ 或 test/ 拖进来（那是别的配置的职责）。
    for (const file of covered) {
      expect(file.startsWith(`scripts${sep}`), `不属于 scripts/ 的文件混进来了：${file}`).toBe(true);
    }
  });

  it('沿用生产的 strict 规则，且只检查不产出', () => {
    const options = parsedScriptsConfig().options;
    expect(options.noEmit).toBe(true);
    expect(options.strict).toBe(true);
    expect(options.module).toBe(ts.ModuleKind.NodeNext);
    expect(options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
    expect(options.jsx).toBe(ts.JsxEmit.ReactJSX);
  });

  it('build 脚本真的跑这一步', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['typecheck:scripts']).toContain('tsconfig.scripts.json');
    expect(pkg.scripts.build).toContain('typecheck:scripts');
  });
});
