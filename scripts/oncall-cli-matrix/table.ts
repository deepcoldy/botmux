/**
 * Render the oncall-sandbox CLI matrix result (run.ts --out) as a markdown
 * table for docs/file-sandbox.md and PR descriptions.
 *
 *   bun scripts/oncall-cli-matrix/table.ts <out.json> [<out.json> ...]
 *
 * Later files override earlier rows for the same CLI × backend × mode.
 */
import { readFileSync } from 'node:fs';

const CHECKS = ['start', 'turn', 'tool', 'rw', 'net', 'send', 'isolated', 'resume'] as const;
const LABEL: Record<typeof CHECKS[number], string> = {
  start: '启动', turn: '首轮收发', tool: 'shell 工具', rw: '工作目录读写',
  net: '联网', send: 'botmux send', isolated: '宿主凭证不可读', resume: '/restart 恢复',
};

interface Check { verdict: 'pass' | 'fail' | 'skip'; detail?: string }
interface Row { cli: string; backend: string; sandbox?: string; checks: Record<string, Check>; note?: string }

const rows = new Map<string, Row>();
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { results: Row[] };
  for (const row of data.results) rows.set(`${row.cli}/${row.backend}/${row.sandbox ?? 'oncall'}`, row);
}

/** Markdown table cell text: escape backslashes first, then pipes. */
const escapeCell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const cell = (c: Check | undefined) => !c ? '—' : c.verdict === 'pass' ? '✅' : c.verdict === 'skip' ? '—' : `❌ ${escapeCell((c.detail ?? '').slice(0, 80))}`;
const lines = [
  `| CLI | 后端 | ${CHECKS.map(c => LABEL[c]).join(' | ')} |`,
  `|---|---|${CHECKS.map(() => '---').join('|')}|`,
];
for (const row of rows.values()) {
  const mode = row.sandbox && row.sandbox !== 'oncall' ? ` (sandbox ${row.sandbox})` : '';
  lines.push(`| ${row.cli}${mode} | ${row.backend} | ${CHECKS.map(c => cell(row.checks[c])).join(' | ')} |`);
}
console.log(lines.join('\n'));
