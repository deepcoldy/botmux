#!/usr/bin/env node
// Release changelog 分类器。
//
// 从 stdin 读 TSV（由 release.yml 的「Generate changelog」步骤产出），每行一条：
//   <kind>\t<ref>\t<title>\t<author>
//   kind   = 'pr' | 'commit'
//   ref    = PR number（pr）或 7 位短 sha（commit）
//   title  = PR 标题 / commit subject（约定式：type(scope): 描述）
//   author = PR 作者 login（仅 pr 行有；commit 行为空）
//
// 输出到 stdout：按约定式提交的 type 前缀分桶成 ✨新功能/🐛修复/… 段落，
// 末尾附去重后的「感谢贡献者」（排除仓库 owner）。pr 行按 number 去重、
// commit 行按 sha 去重——同一 PR 的多个子 commit 反查到同一 number 只列一次。
//
// 仓库强制 `type(scope): 中文描述` 提交规范，故 type 前缀几乎总在；解析不出
// type 的条目归入「🔧 其它」，不丢。

import { readFileSync } from 'node:fs';

const owner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();

// type → 段落。顺序即输出顺序；未命中的 type 落到 OTHER。
const SECTIONS = [
  { title: '✨ 新功能', types: ['feat'] },
  { title: '🐛 修复', types: ['fix'] },
  { title: '⚡️ 性能', types: ['perf'] },
  { title: '♻️ 重构', types: ['refactor'] },
  { title: '📝 文档', types: ['docs'] },
];
const OTHER = '🔧 其它';

const lines = readFileSync(0, 'utf8').split('\n').filter((l) => l.length > 0);

const seenPr = new Set();
const seenCommit = new Set();
const authors = new Set();
/** @type {{ section: string, line: string }[]} */
const entries = [];

const sectionFor = (type) => SECTIONS.find((s) => s.types.includes(type))?.title ?? OTHER;

for (const raw of lines) {
  const [kind, ref, title = '', author = ''] = raw.split('\t');
  if (kind === 'pr') {
    if (seenPr.has(ref)) continue;
    seenPr.add(ref);
    const login = author.trim();
    if (login && login.toLowerCase() !== owner) authors.add(login);
  } else {
    if (seenCommit.has(ref)) continue;
    seenCommit.add(ref);
  }

  const m = title.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/);
  const type = m ? m[1].toLowerCase() : '';
  const scope = m && m[2] ? m[2].trim() : '';
  const breaking = m && m[3] ? '⚠️ ' : '';
  const desc = m ? m[4].trim() : title.trim();
  const suffix = kind === 'pr' ? ` (#${ref})` : ` (${ref})`;
  const line = `- ${breaking}${scope ? `**${scope}**: ` : ''}${desc}${suffix}`;
  entries.push({ section: sectionFor(type), line });
}

const out = [];
for (const section of [...SECTIONS.map((s) => s.title), OTHER]) {
  const items = entries.filter((e) => e.section === section);
  if (items.length === 0) continue;
  out.push(`## ${section}`);
  for (const it of items) out.push(it.line);
  out.push('');
}

if (authors.size > 0) {
  out.push('## 🙏 感谢贡献者');
  out.push([...authors].map((a) => `@${a}`).join(' '));
}

process.stdout.write(out.join('\n').replace(/\n+$/, '') + '\n');
