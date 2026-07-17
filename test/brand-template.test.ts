import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBrandTemplate } from '../src/im/lark/brand-template.js';

// 镜像 brand-template.ts 的 safeText：脚注里显示的文本会走 escapeLarkMd（& < > * _ ~ `）
// + 剥离链接结构 [ ] ( )。路径派生的显示值也过它，所以下面用它算期望。
const escText = (s: string) =>
  s.replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1').replace(/[[\]()]/g, '');

describe('renderBrandTemplate', () => {
  it('不含 { 的模板原样返回（含 undefined/空串/默认值）', () => {
    expect(renderBrandTemplate(undefined, '/tmp/x')).toBeUndefined();
    expect(renderBrandTemplate('', '/tmp/x')).toBe('');
    expect(renderBrandTemplate('[botmux](https://github.com/deepcoldy/botmux)', '/tmp/x'))
      .toBe('[botmux](https://github.com/deepcoldy/botmux)');
  });

  it('{cwdName} 取目录 basename，{cwd} 取全路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(escText(basename(dir)));
    expect(renderBrandTemplate('{cwd}', dir)).toBe(escText(dir));
  });

  it('.botmux-dir.json 的 name 覆盖 basename、url 填充 {cwdUrl}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '售后客服', url: 'https://x.feishu.cn/docx/abc' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('[售后客服](https://x.feishu.cn/docx/abc)');
  });

  it('workingDir 以 ~ 开头时展开成 home 再读 .botmux-dir.json（oncall 绑定存的就是字面量 ~）', () => {
    // 复现：resolvePinnedWorkingDir 走 oncallEntry.workingDir 那一支时不展开 ~，
    // 字面量 `~/...` 直接流到这里；Node 的 fs 不认 ~ → statSync ENOENT → 角色名丢失。
    // 其它消费方（session-manager.ts spawn 的 cwd）都 expandHome 了，只有这里漏了。
    const home = homedir();
    const dir = mkdtempSync(join(home, '.brand-tilde-'));
    try {
      writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '默认助理', url: 'https://x.feishu.cn/docx/abc' }));
      const tilde = `~/${basename(dir)}`;             // 字面量 ~，正是 oncall 绑定里存的形态
      expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', tilde)).toBe('[默认助理](https://x.feishu.cn/docx/abc)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── codex review 抓出的 4 条（均已复现）──────────────────────────────
  it('name/url 是不可信输入：剥离 []、换行，拒绝非 http(s) 与含 ) 的 url（防卡片注入）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-inj-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({
      name: 'role]\n**伪造正文**',
      url: 'https://safe.example/x) 后续正文',
    }));
    const out = renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)!;
    expect(out).not.toContain('**伪造正文**]');   // 链接文本没被击穿
    expect(out).not.toContain('\n');
    expect(out).not.toContain(']');                // 文本位无裸 ]
    expect(out).toContain('\\*\\*');              // markdown 强调被转义中和
    expect(out).not.toMatch(/(?<!\\)\*\*/);        // 没有未转义的 **
  });

  it('目录名本身含 ] 时也要消毒（basename fallback / {cwd} 同样落在链接文本位）', () => {
    // `mkdir 'a]b'` 完全合法 —— 没有 .botmux-dir.json 时 {cwdName} 回落到 basename(wd)，
    // 目录名里的 ] 照样能击穿 [text](url)。
    const dir = mkdtempSync(join(tmpdir(), 'brand-]evil-'));
    const out = renderBrandTemplate('[{cwdName}](https://x.example/)', dir)!;
    expect(out).toContain('](https://x.example/)');       // 链接结构完好
    expect(out.split('](https://x.example/)')[0]).not.toContain(']');  // 文本位没有裸 ]
    expect(renderBrandTemplate('{cwd}', dir)).not.toContain(']');
  });

  it('javascript: 等危险 scheme 一律丢弃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-js-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'x', url: 'javascript:alert(1)' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('x');
  });

  it('safeUrl 拒绝 userinfo 钓鱼形态与反斜杠', () => {
    const mk = (url: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'brand-url-'));
      writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'x', url }));
      return renderBrandTemplate('[{cwdName}]({cwdUrl})', dir);
    };
    expect(mk('https://trusted.example@evil.example/p')).toBe('x');  // userinfo → 丢弃 → 降级
    expect(mk('https://example.com\\')).toBe('x');                   // 反斜杠 → 丢弃
    expect(mk('https://x.feishu.cn/docx/abc')).toBe('[x](https://x.feishu.cn/docx/abc)'); // 正常 url 照过
  });

  it('workingDir 恰好是 `~` 时，{cwdName} 取 home 的 basename 而不是字面量 ~', () => {
    expect(renderBrandTemplate('{cwdName}', '~')).toBe(basename(homedir()));
  });

  it('{cwd} 输出展开后的绝对路径，不是字面量 ~/...', () => {
    expect(renderBrandTemplate('{cwd}', '~/foo')).toBe(join(homedir(), 'foo'));
  });

  // ── codex 复验抓出的 2 条残留 ────────────────────────────────────────
  it('name 不能注入 lark_md 标签（</font><at> 伪造 @提及）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-font-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({
      name: "x</font><at id=ou_x></at><font color='grey'>",
    }));
    const out = renderBrandTemplate('{cwdName}', dir)!;
    expect(out).not.toContain('<');          // < 已转义
    expect(out).not.toContain('<at');
    expect(out).not.toContain('</font');
    expect(out).toContain('&lt;');           // 变成转义实体
  });

  it('目录名含 < 或 markdown 强调字符时被转义（路径派生值同样过 escapeLarkMd）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-lt-'));
    const evil = join(dir, 'a<font>b');   // 单段名（不含 /，否则会被当嵌套路径）
    mkdirSync(evil);
    const out = renderBrandTemplate('{cwdName}', evil)!;
    expect(out).not.toContain('<font>');
    expect(out).toContain('a&lt;font&gt;b');
  });

  it('变量落在 URL 位时也安全：路径里的 ) 不能提前闭合链接', () => {
    // brandLabel 是用户可配的，{cwd} 完全可能被放进 URL 位；而目录名可以含 `)`。
    const dir = mkdtempSync(join(tmpdir(), 'brand-paren-'));
    const evil = join(dir, 'a) **spoof**');
    mkdirSync(evil);
    const out = renderBrandTemplate('[repo]({cwd})', evil)!;
    expect(out).not.toContain(') **spoof**');   // 没有提前闭合
    expect(out.endsWith(')')).toBe(true);
    expect((out.match(/\)/g) ?? []).length).toBe(1);  // 只有结尾那一个 )
  });

  it('反斜杠先转义：`\\*bold\\*` 不能靠偶数反斜杠让 * 复活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-bs-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '\\*bold\\*' }));
    const out = renderBrandTemplate('{cwdName}', dir)!;
    // 每个反斜杠翻倍 + 每个 * 前补一个 \\ → * 前面是奇数个反斜杠 → 被吃掉，不成强调
    expect(out).not.toMatch(/(?<!\\)(?:\\\\)*\*/);  // 没有「偶数反斜杠 + 裸 *」
  });

  it('截断不切断转义序列：末尾不留落单反斜杠（会转义模板的 ]）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-trunc-'));
    // name 恰好 64 码点、末尾是需转义的 * → 先转义后截断会把 \* 切成落单 \
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({
      name: 'a'.repeat(63) + '*', url: 'https://x.feishu.cn/docx/abc',
    }));
    const out = renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)!;
    expect(out).toContain('](https://x.feishu.cn/docx/abc)');  // 链接结构完好，] 没被 \ 转义吃掉
    expect(out.split('](')[0]).not.toMatch(/\\$/);           // 文本位末尾不是落单反斜杠
  });

  it('safeUrl 挡掉 https://// 归一混淆', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-slash-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'x', url: 'https:////evil.example' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('x');  // 丢弃 → 降级
  });

  it('name 按码点截断，不切坏 emoji', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-emoji-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'a'.repeat(63) + '😀' }));
    const out = renderBrandTemplate('{cwdName}', dir)!;
    expect(out.endsWith('😀')).toBe(true);      // 完整的 emoji，不是半个代理对
    expect(out).not.toContain('\uFFFD');
  });

  it('url 缺失时空链接降级为纯文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe(basename(dir));
  });

  it('workingDir 为 undefined 时变量替换为空串并降级', () => {
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', undefined)).toBe('');
  });

  it('元文件损坏时按不存在处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), '{not json');
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(basename(dir));
  });

  it('替换进去的值含变量字面量时不被二次替换', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'foo{cwd}bar' }));
    expect(renderBrandTemplate('{cwdName}', dir)).toBe('foo{cwd}bar');
  });
});
