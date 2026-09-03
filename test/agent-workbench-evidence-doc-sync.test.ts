import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readDoc = () => readFileSync(join(repoRoot, 'docs/agent-workbench-implementation.md'), 'utf8');
const readAsset = (name: string) =>
  JSON.parse(readFileSync(join(repoRoot, 'docs/assets', name), 'utf8')) as Record<string, any>;
// 文档是按 80 列手工折行的，负向断言必须先抹掉换行再比对，否则改个折行就假绿。
const squeeze = (text: string) => text.replace(/\s+/g, '');

// 验收段落的口径必须跟脚本真正断言的东西对得上。这两处曾经把「外传通道是通的、
// 只是载荷里没东西」写成「断言全部失败」，把「按能力根本没发请求」写成「演练过
// 401 降级」——两者都比证据本身强。
describe('agent workbench 验收证据表述与机器可读产物同源', () => {
  it('外传段落如实写明沙箱不封出网，断言的只是载荷不含受保护值', () => {
    const doc = readDoc();
    const results = readAsset('preview-origin-isolation-results.json');
    // 脚本 481 行 `assert.ok(collectorRequests.length > 0)` 要求外传**成功发生**，
    // 所以「断言全部失败」这种写法与脚本自身矛盾。
    expect(squeeze(doc)).not.toContain('断言全部失败');
    expect(results.findings.attack.exfiltration).toBe('sent:200');
    expect(doc).toContain(results.findings.attack.exfiltration);
    expect(doc).toContain(`送出 ${results.findings.exfiltratedBytes} 字节`);
    expect(doc).toContain('载荷里不含任何受保护值');
  });

  it('schedules 段落把能力门记在浏览器脚本名下、401 兜底记在单测名下', () => {
    const doc = readDoc();
    const results = readAsset('workbench-schedules-degradation-results.json');
    // 浏览器里 `/api/schedules` 一跳都没发生，因此 401 分支在这份证据里是死代码。
    expect(results.workbenchOnly.scheduleRequests).toBe(0);
    expect(squeeze(doc)).not.toContain('证明排程401只让排程区块降级、不动会话快照');
    expect(squeeze(doc)).toContain('按能力根本不请求`/api/schedules`（`scheduleRequests:0`）');
    expect(doc).toContain('test/dashboard-store-bootstrap.test.ts');

    // 文档把 401 兜底指给了单测，那份单测必须真的存在这条用例。
    const unitTest = readFileSync(join(repoRoot, 'test/dashboard-store-bootstrap.test.ts'), 'utf8');
    expect(unitTest).toContain('installs the sessions snapshot even when /api/schedules answers 401 with an HTML login page');
  });
});
