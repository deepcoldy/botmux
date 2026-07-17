import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRoleLibraryPath } from '../src/core/role-library.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'rolelib-'));
  const root = join(base, 'botmux-roles');
  mkdirSync(join(root, 'users', 'ou_x', '产品经理'), { recursive: true });
  return { base, root };
}

describe('validateRoleLibraryPath', () => {
  it('放行根下的角色目录（返回 realpath）', () => {
    const { root } = setup();
    const r = validateRoleLibraryPath(join(root, 'users', 'ou_x', '产品经理'), root);
    expect(r.ok).toBe(true);
  });
  it('拒绝根之外的目录与 .. 穿越', () => {
    const { base, root } = setup();
    expect(validateRoleLibraryPath(base, root).ok).toBe(false);
    expect(validateRoleLibraryPath(join(root, 'users', '..', '..'), root).ok).toBe(false);
  });
  it('拒绝符号链接逃逸', () => {
    const { base, root } = setup();
    const outside = join(base, 'secret'); mkdirSync(outside);
    symlinkSync(outside, join(root, 'evil'));
    const r = validateRoleLibraryPath(join(root, 'evil'), root);
    expect(r).toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝前缀兄弟目录（botmux-roles-evil）', () => {
    const { base, root } = setup();
    mkdirSync(join(base, 'botmux-roles-evil'));
    expect(validateRoleLibraryPath(join(base, 'botmux-roles-evil'), root))
      .toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝不存在的路径与文件', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(join(root, 'nope'), root).ok).toBe(false);
    const f = join(root, 'a.txt'); writeFileSync(f, 'x');
    expect(validateRoleLibraryPath(f, root)).toEqual({ ok: false, error: 'not_a_directory' });
  });
  it('拒绝根目录本身', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(root, root)).toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('展开前导 ~（引号内 shell 不展开时不误报 dir_not_found，与 IM /cd 行为一致）', () => {
    // 在真实 $HOME 下建临时角色库（mkdtemp 随机后缀避免撞名），以 root 为
    // rootOverride，用 ~/<相对路径> 调用——只有 expandHome 生效才能命中。
    const home = realpathSync(homedir());
    const base = mkdtempSync(join(home, '.rolelib-tilde-'));
    try {
      const root = join(base, 'botmux-roles');
      const role = join(root, 'pm');
      mkdirSync(role, { recursive: true });
      const viaTilde = `~/${relative(home, role)}`;
      const r = validateRoleLibraryPath(viaTilde, root);
      expect(r).toEqual({ ok: true, resolvedPath: realpathSync(role) });
      // 裸 ~ 展开后是 home 本身——在库外，照拒。
      expect(validateRoleLibraryPath('~', root)).toEqual({ ok: false, error: 'outside_role_library' });
    } finally {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
  it('拒绝空串与空白串', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath('', root)).toEqual({ ok: false, error: 'empty_path' });
    expect(validateRoleLibraryPath('   ', root)).toEqual({ ok: false, error: 'empty_path' });
  });
  it('rootOverride 指向不存在的目录 → role_library_missing', () => {
    const { base, root } = setup();
    expect(validateRoleLibraryPath(join(root, 'users'), join(base, 'no-such-root')))
      .toEqual({ ok: false, error: 'role_library_missing' });
  });
  it('拒绝内嵌控制字符（单行注入不变量，与 slash 的 multiline_rejected 对称）', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(`${join(root, 'users')}\nrm -rf /`, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
    expect(validateRoleLibraryPath(`${join(root, 'users')}\r\nevil`, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
  });
  it('拒绝内嵌 ESC / tab 等其余 C0 控制字符与 DEL（不止 \\r\\n）', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(`${join(root, 'users')}\x1b[31mevil`, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
    expect(validateRoleLibraryPath(`${join(root, 'users')}\tevil`, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
    expect(validateRoleLibraryPath(`${join(root, 'users')}\x7fevil`, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
  });
  it('拒绝库内符号链接解析出的含换行 resolvedPath（干净名字符号链接 → 库内含 \\n 的目录）', () => {
    const { root } = setup();
    // 目标目录在库内：不加 resolvedPath 复检时会通过 containment 并返回
    // ok:true 且 resolvedPath 含 \n——正是「洗出」场景；现应被拦下。
    const target = join(root, 'evil\ndir'); mkdirSync(target);
    const link = join(root, 'clean-link');
    symlinkSync(target, link);
    expect(validateRoleLibraryPath(link, root))
      .toEqual({ ok: false, error: 'invalid_path_chars' });
  });
});
