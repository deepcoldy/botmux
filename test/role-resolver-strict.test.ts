/**
 * §6 角色严格回读（readRoleFileStrict / normalizeRoleContent / roleContentHash）。
 * 用真实临时目录 + 真实文件系统（不 mock config），验证四态区分。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readRoleFileStrict, normalizeRoleContent, roleContentHash, writeRoleFile } from '../src/core/role-resolver.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'role-strict-'));
  // readRoleFileStrict 走 roleFilePath，依赖 config.session.dataDir。直接 stub env。
  process.env.SESSION_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.SESSION_DATA_DIR;
});

const APP = 'cli_role_app';
const CHAT = 'oc_role_chat';

function roleFilePath(): string {
  return join(dataDir, 'roles', APP, `${CHAT}.md`);
}

describe('readRoleFileStrict 四态', () => {
  it('缺失 → missing', () => {
    expect(readRoleFileStrict(APP, CHAT)).toEqual({ kind: 'missing' });
  });

  it('空文件 → empty', () => {
    mkdirSync(dirname(roleFilePath()), { recursive: true });
    writeFileSync(roleFilePath(), '   \n  ', 'utf-8');
    expect(readRoleFileStrict(APP, CHAT)).toEqual({ kind: 'empty' });
  });

  it('正常内容 → readable 且已 normalize（trim + 截断）', () => {
    mkdirSync(dirname(roleFilePath()), { recursive: true });
    writeFileSync(roleFilePath(), '  你是一个助手  \n', 'utf-8');
    const r = readRoleFileStrict(APP, CHAT);
    expect(r.kind).toBe('readable');
    if (r.kind === 'readable') expect(r.content).toBe('你是一个助手');
  });

  it('read-error 不被当 missing（读目录当文件）', () => {
    mkdirSync(dirname(roleFilePath()), { recursive: true });
    // 把 role 文件路径建成一个目录，readFileSync 会抛 EISDIR。
    mkdirSync(roleFilePath(), { recursive: true });
    const r = readRoleFileStrict(APP, CHAT);
    expect(r.kind).toBe('read-error');
  });

  // root 绕过 DAC 权限位，chmod 000 不产生 EACCES（读仍成功），该用例仅在非 root 下有区分力。
  it.skipIf(process.getuid?.() === 0)('R3：父目录不可遍历（非 ENOENT）判 read-error 不判 missing', () => {
    mkdirSync(join(dataDir, 'roles'), { recursive: true });
    const appDir = join(dataDir, 'roles', APP);
    mkdirSync(appDir, { recursive: true });
    chmodSync(appDir, 0o000); // 不可读/不可遍历
    try {
      const r = readRoleFileStrict(APP, CHAT);
      expect(r.kind).toBe('read-error');
    } finally {
      chmodSync(appDir, 0o755);
    }
  });

  it('invalid chat id → read-error（不是 missing）', () => {
    expect(readRoleFileStrict(APP, 'not-a-valid-id').kind).toBe('read-error');
  });
});

describe('normalizeRoleContent / roleContentHash 与 writeRoleFile 同源', () => {
  it('normalizeRoleContent = trim + UTF-8 32KB 截断', () => {
    expect(normalizeRoleContent('  abc  ')).toBe('abc');
    const long = '雪'.repeat(40 * 1024); // 每个 3 bytes，远超 32KB
    expect(Buffer.byteLength(normalizeRoleContent(long), 'utf-8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('roleContentHash 是规范化后落盘字节的 sha256，与原始输入无关', () => {
    expect(roleContentHash('  abc  ')).toBe(roleContentHash('abc'));
    expect(roleContentHash('abc')).not.toBe(roleContentHash('def')); // 不同内容
  });

  it('R6：roleContentHash 直接 hash UTF-8 字节，符合已知 SHA-256 协议值', () => {
    // sha256(utf8('abc')) = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(roleContentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('writeRoleFile 落盘后 roleContentHash 与 readRoleFileStrict readable 一致', () => {
    writeRoleFile(APP, CHAT, '  你好\n');
    const r = readRoleFileStrict(APP, CHAT);
    expect(r.kind).toBe('readable');
    if (r.kind === 'readable') {
      expect(roleContentHash('你好')).toBe(roleContentHash(r.content));
    }
    // 落盘文件确实存在
    expect(existsSync(roleFilePath())).toBe(true);
  });
});
