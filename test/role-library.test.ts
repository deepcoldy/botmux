import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { roleLibrarySubtree, validateRoleLibraryPath } from '../src/core/role-library.js';

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

describe('roleLibrarySubtree（沙盒白名单用）', () => {
  it('真实目录 → 根 realpath 下的同名单段路径', () => {
    const { root } = setup();
    mkdirSync(join(root, 'cli_abc123'));
    expect(roleLibrarySubtree('cli_abc123', root)).toBe(join(realpathSync(root), 'cli_abc123'));
  });
  it('拒绝任何会解析到角色库之外的 appId（分隔符 / .. / 空值 / 控制字符）', () => {
    const { root } = setup();
    // join('/r', '../../.ssh') === '/.ssh' —— `..` 被 join 吃掉，normalizeFsPath
    // 的 `..` 拦截够不到，所以必须在拼路径前就挡住。
    for (const bad of ['../../.ssh', '..', '.', 'a/b', '/abs', '', 'x\ny', 'a b']) {
      expect(roleLibrarySubtree(bad, root)).toBeNull();
    }
    expect(roleLibrarySubtree(undefined as unknown as string, root)).toBeNull();
  });
  it('子树是符号链接 → null（否则 realpath 会把链接目标当成本 bot 的子树授 rw）', () => {
    const { base, root } = setup();
    // 库外的敏感目录（模拟 ~/.ssh），以及另一个 bot 的角色库
    const outside = join(base, 'secret'); mkdirSync(outside);
    mkdirSync(join(root, 'cli_other', 'users', 'ou_y'), { recursive: true });
    symlinkSync(outside, join(root, 'cli_escape'));
    symlinkSync(join(root, 'cli_other'), join(root, 'cli_crossbot'));
    expect(roleLibrarySubtree('cli_escape', root)).toBeNull();
    expect(roleLibrarySubtree('cli_crossbot', root)).toBeNull();
    // 对照：同名真实目录照常放行
    mkdirSync(join(root, 'cli_real'));
    expect(roleLibrarySubtree('cli_real', root)).not.toBeNull();
  });
  it('不存在、或是文件而非目录 → null', () => {
    const { root } = setup();
    expect(roleLibrarySubtree('cli_missing', root)).toBeNull();
    writeFileSync(join(root, 'cli_file'), 'x');
    expect(roleLibrarySubtree('cli_file', root)).toBeNull();
  });
  it('角色库根不存在 → null', () => {
    const { base } = setup();
    expect(roleLibrarySubtree('cli_x', join(base, 'no-such-root'))).toBeNull();
  });
  it('角色库根本身是符号链接 → null（末两段都不许跟链，否则整棵库被替换掉）', () => {
    const { base, root } = setup();
    mkdirSync(join(root, 'cli_x'));
    // 库外目录，里面也放一个同名 appId 目录：跟链的实现会返回它
    const fake = join(base, 'fake-roles'); mkdirSync(join(fake, 'cli_x'), { recursive: true });
    const link = join(base, 'roles-link');
    symlinkSync(fake, link);
    expect(roleLibrarySubtree('cli_x', link)).toBeNull();
  });
  it('根之上的中间段是符号链接 → 照常放行，且返回 canonical 路径（$HOME 本身是链接的机器）', () => {
    // 只 realpath 根的父目录：/home/u → /data00/home/u 这类布局不能因此 fail-open，
    // 也不能被误拒。这里用一个指向 base 的链接充当「符号链接的 $HOME」。
    const { base, root } = setup();
    mkdirSync(join(root, 'cli_x'));
    const homeLink = join(mkdtempSync(join(tmpdir(), 'homelink-')), 'home');
    symlinkSync(base, homeLink);
    expect(roleLibrarySubtree('cli_x', join(homeLink, 'botmux-roles')))
      .toBe(join(realpathSync(root), 'cli_x'));
  });
});

describe('validateRoleLibraryPath + ownAppId（收窄到本 bot 自己的子树）', () => {
  function twoBots() {
    const { base, root } = setup();
    const own = join(root, 'cli_self'), other = join(root, 'cli_other');
    mkdirSync(join(own, 'shared', 'default'), { recursive: true });
    mkdirSync(join(own, 'users', 'ou_x', 'pm'), { recursive: true });
    mkdirSync(join(other, 'shared', 'default'), { recursive: true });
    mkdirSync(join(other, 'users', 'ou_y', 'secret'), { recursive: true });
    return { base, root, own, other };
  }
  it('放行自己子树内的角色目录', () => {
    const { root, own } = twoBots();
    expect(validateRoleLibraryPath(join(own, 'shared', 'default'), root, 'cli_self'))
      .toEqual({ ok: true, resolvedPath: realpathSync(join(own, 'shared', 'default')) });
    expect(validateRoleLibraryPath(join(own, 'users', 'ou_x', 'pm'), root, 'cli_self').ok).toBe(true);
  });
  it('拦住跨 bot 切换（库内但不在自己子树）→ outside_own_role_library', () => {
    const { root, other } = twoBots();
    expect(validateRoleLibraryPath(join(other, 'shared', 'default'), root, 'cli_self'))
      .toEqual({ ok: false, error: 'outside_own_role_library' });
    // 别人的私有角色同样拦住
    expect(validateRoleLibraryPath(join(other, 'users', 'ou_y', 'secret'), root, 'cli_self'))
      .toEqual({ ok: false, error: 'outside_own_role_library' });
    // 不传 ownAppId = 旧行为：跨 bot 可切（存量语义，回归对照）
    expect(validateRoleLibraryPath(join(other, 'shared', 'default'), root).ok).toBe(true);
  });
  it('库外仍报 outside_role_library（两种越界可区分）', () => {
    const { base, root } = twoBots();
    expect(validateRoleLibraryPath(base, root, 'cli_self'))
      .toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('自己子树本身（每-bot 根）被拒——与「拒绝库根本身」同一不变量', () => {
    const { root, own } = twoBots();
    expect(validateRoleLibraryPath(own, root, 'cli_self').ok).toBe(false);
  });
  it('存量人类 slug 布局（<root>/<appId> 不存在）→ FAIL-CLOSED own_role_library_missing（不回落全局根）', () => {
    const { root } = setup();  // 只有 users/ou_x/产品经理，没有 cli_* 目录
    const legacy = join(root, 'users', 'ou_x', '产品经理');
    // 曾经回落全局根（fail-open：存量部署可继续跨 bot 切）；现在必须直接拒。
    expect(validateRoleLibraryPath(legacy, root, 'cli_self'))
      .toEqual({ ok: false, error: 'own_role_library_missing' });
  });
  it('子树是符号链接（roleLibrarySubtree 返 null）→ FAIL-CLOSED，绝不因跟链把别人的库当成自己的', () => {
    const { root, other } = twoBots();
    // cli_link 指向别的 bot 的库：roleLibrarySubtree 对 symlink 子树返 null → 本应
    // fail-closed，绝不能回落全局根后把 other 的库内目录判为「合法切换」。
    symlinkSync(other, join(root, 'cli_link'));
    expect(validateRoleLibraryPath(join(other, 'shared', 'default'), root, 'cli_link'))
      .toEqual({ ok: false, error: 'own_role_library_missing' });
  });
  it('fail-closed 只作用于传了 ownAppId 的调用；不传 ownAppId 仍是旧全局根语义', () => {
    // 内部/测试调用方不传 ownAppId：<root>/<appId> 不存在也不影响，仍按全局根放行库内目录。
    const { root } = setup();
    const legacy = join(root, 'users', 'ou_x', '产品经理');
    expect(validateRoleLibraryPath(legacy, root))
      .toEqual({ ok: true, resolvedPath: realpathSync(legacy) });
  });
});
