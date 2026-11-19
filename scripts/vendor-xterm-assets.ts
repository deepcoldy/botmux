#!/usr/bin/env bun
/**
 * 生成 `src/core/xterm-vendor-assets-data.ts`：Web 终端页用的 xterm 5.5.0 组（#1940
 * 固定的版本）的原始文件，gzip 后 base64 内嵌进源码。
 *
 * 用法（只在升级这组版本时手动跑，构建不跑、也不联网）：
 *   bun scripts/vendor-xterm-assets.ts           # 下载、校验、写入
 *   bun scripts/vendor-xterm-assets.ts --check   # 下载、校验，与已提交的内容逐字节比对，不写
 * 镜像源：BOTMUX_VENDOR_NPM_REGISTRY=<registry 根地址>（integrity 照样校验，镜像改不了内容）。
 *
 * 为什么内嵌成 TS 模块、不放成 dist/ 下的文件：npm 用户装到的是 bun 编译的单文件二进制，
 * 那里 `__dirname` 是虚拟的 /$bunfs/root，`cp` 进 dist/ 的文件在二进制里根本不存在
 * （见 scripts/audit-embedded-assets.mjs 记的两次事故）；`with { type: 'file' }` 又只有
 * Bun 认、tsc/vitest 不认。普通的字符串常量模块在源码运行、`node dist/`、编译二进制三种
 * 形态里都一样能用（与 src/setup/app-icon-data.ts 同一个理由）。
 *
 * 为什么 gzip：七个文件原样约 500KB，gzip 后约 124KB。worker 直接把 gzip 字节发给声明
 * 支持 gzip 的浏览器（几乎全部），不支持的才现解压；源码与二进制也小得多。
 *
 * 校验链：tarball 先按 `src/core/xterm-vendor-assets.ts` 里钉住的 npm integrity（sha512）
 * 校验，不符直接失败；生成的模块给每个文件记下原文 sha256，单测解压后核对，
 * `--check` 则重新下载、按原文逐字节比对已提交的内容。
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  XTERM_VENDOR_ASSETS,
  XTERM_VENDOR_PACKAGES,
  type XtermVendorPackage,
  type XtermVendorPackageKey,
} from '../src/core/xterm-vendor-assets.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_MODULE = join(REPO_ROOT, 'src', 'core', 'xterm-vendor-assets-data.ts');
const REGISTRY = (process.env.BOTMUX_VENDOR_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');

function tarballUrl(pkg: XtermVendorPackage): string {
  const bare = pkg.name.slice(pkg.name.indexOf('/') + 1);
  return `${REGISTRY}/${pkg.name}/-/${bare}-${pkg.version}.tgz`;
}

function verifyIntegrity(pkg: XtermVendorPackage, tgz: Buffer): void {
  const dash = pkg.integrity.indexOf('-');
  const algo = pkg.integrity.slice(0, dash);
  const expected = pkg.integrity.slice(dash + 1);
  const actual = createHash(algo).update(tgz).digest('base64');
  if (actual !== expected) {
    throw new Error(`${pkg.name}@${pkg.version}: tarball integrity mismatch (expected ${pkg.integrity}, got ${algo}-${actual})`);
  }
}

/** 最小 ustar 读取：只取普通文件，名字带 ustar prefix 时拼上。 */
function readTar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === '0' || type === '\0') files.set(prefix ? `${prefix}/${name}` : name, Buffer.from(body));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchPackageFiles(key: XtermVendorPackageKey): Promise<Map<string, Buffer>> {
  const pkg = XTERM_VENDOR_PACKAGES[key];
  const res = await fetch(tarballUrl(pkg));
  if (!res.ok) throw new Error(`${tarballUrl(pkg)}: HTTP ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  verifyIntegrity(pkg, tgz);
  return readTar(gunzipSync(tgz));
}

interface VendoredFile {
  path: string;
  raw: Buffer;
  license: string;
}

async function collect(): Promise<VendoredFile[]> {
  const byPackage = new Map<XtermVendorPackageKey, Map<string, Buffer>>();
  const out: VendoredFile[] = [];
  for (const a of Object.values(XTERM_VENDOR_ASSETS)) {
    let files = byPackage.get(a.packageKey);
    if (!files) {
      files = await fetchPackageFiles(a.packageKey);
      byPackage.set(a.packageKey, files);
    }
    const raw = files.get(`package/${a.file}`);
    if (!raw) throw new Error(`${XTERM_VENDOR_PACKAGES[a.packageKey].name}: package/${a.file} not in tarball`);
    const license = files.get('package/LICENSE');
    if (!license) throw new Error(`${XTERM_VENDOR_PACKAGES[a.packageKey].name}: LICENSE not in tarball`);
    out.push({ path: a.path, raw, license: license.toString('utf8').trim() });
  }
  return out;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function renderModule(files: VendoredFile[]): string {
  const licenses = new Map<string, string[]>();
  for (const f of files) {
    const pkg = Object.values(XTERM_VENDOR_ASSETS).find((a) => a.path === f.path)!;
    const id = `${XTERM_VENDOR_PACKAGES[pkg.packageKey].name}@${XTERM_VENDOR_PACKAGES[pkg.packageKey].version}`;
    const owners = licenses.get(f.license) ?? [];
    if (!owners.includes(id)) owners.push(id);
    licenses.set(f.license, owners);
  }
  const licenseLines: string[] = [];
  for (const [text, owners] of licenses) {
    licenseLines.push(` * ${owners.join(', ')}:`, ' *');
    for (const line of text.split(/\r?\n/)) licenseLines.push(line ? ` *   ${line.replace(/\*\//g, '*\\/')}` : ' *');
    licenseLines.push(' *');
  }
  const entries = files.map((f) => [
    `  ${JSON.stringify(f.path)}: {`,
    `    sha256: '${sha256(f.raw)}',`,
    `    bytes: ${f.raw.length},`,
    `    gzipBase64: '${gzipSync(f.raw, { level: 9 }).toString('base64')}',`,
    '  },',
  ].join('\n'));
  return [
    '// GENERATED by scripts/vendor-xterm-assets.ts — do not edit by hand.',
    '// Regenerate / verify with `bun scripts/vendor-xterm-assets.ts [--check]`.',
    '//',
    '// Web 终端页用的 xterm 组件原文（gzip + base64），逐字节取自 npm tarball，版本与 integrity',
    '// 见 src/core/xterm-vendor-assets.ts。只由 src/core/xterm-vendor-serve.ts 按需动态加载。',
    '',
    '/**',
    ' * @license',
    ' * Vendored, unmodified files from the xterm.js project (MIT):',
    ' *',
    ...licenseLines,
    ' */',
    '',
    'export interface XtermVendorAssetData {',
    '  /** sha256 (hex) of the original, uncompressed file. */',
    '  readonly sha256: string;',
    '  /** Byte length of the original, uncompressed file. */',
    '  readonly bytes: number;',
    '  readonly gzipBase64: string;',
    '}',
    '',
    'export const XTERM_VENDOR_ASSET_DATA: Readonly<Record<string, XtermVendorAssetData>> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}

/** 已提交模块里每个文件的原文（解压后），给 --check 用。 */
async function committedFiles(): Promise<Map<string, Buffer>> {
  const mod = await import(`${DATA_MODULE}?t=${Date.now()}`) as {
    XTERM_VENDOR_ASSET_DATA: Record<string, { gzipBase64: string }>;
  };
  return new Map(Object.entries(mod.XTERM_VENDOR_ASSET_DATA).map(([path, d]) => [
    path,
    gunzipSync(Buffer.from(d.gzipBase64, 'base64')),
  ]));
}

async function main(): Promise<void> {
  const files = await collect();
  if (process.argv.includes('--check')) {
    const committed = await committedFiles();
    const problems: string[] = [];
    for (const f of files) {
      const have = committed.get(f.path);
      if (!have) problems.push(`${f.path}: missing from ${DATA_MODULE}`);
      else if (!have.equals(f.raw)) problems.push(`${f.path}: content differs from the npm tarball`);
    }
    for (const path of committed.keys()) {
      if (!files.some((f) => f.path === path)) problems.push(`${path}: not in the manifest`);
    }
    if (problems.length) {
      console.error(`[vendor-xterm] ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`[vendor-xterm] ${files.length} files match the pinned npm tarballs byte for byte`);
    return;
  }
  const next = renderModule(files);
  let current = '';
  try { current = readFileSync(DATA_MODULE, 'utf8'); } catch { /* first run */ }
  if (current === next) {
    console.log('[vendor-xterm] src/core/xterm-vendor-assets-data.ts already up to date');
    return;
  }
  writeFileSync(DATA_MODULE, next);
  const raw = files.reduce((n, f) => n + f.raw.length, 0);
  console.log(`[vendor-xterm] wrote src/core/xterm-vendor-assets-data.ts (${files.length} files, ${raw} bytes uncompressed)`);
}

await main();
