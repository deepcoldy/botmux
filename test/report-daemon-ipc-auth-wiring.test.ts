import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function reportCommandSource(): string {
  const source = readFileSync(resolve('src/cli.ts'), 'utf8');
  const start = source.indexOf('async function cmdReport(');
  const end = source.indexOf('// ─── Verified delivery help', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function dispatchCommandSource(): string {
  const source = readFileSync(resolve('src/cli.ts'), 'utf8');
  const start = source.indexOf('async function cmdDispatch(');
  const end = source.indexOf('/**\n * `botmux report`', start);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('botmux report daemon IPC auth wiring', () => {
  it('strips trailing memory citations before every report delivery and preview path', () => {
    const source = reportCommandSource();
    const sanitize = source.indexOf('content = stripTrailingOaiMemoryCitation(content);');

    expect(sanitize).toBeGreaterThan(source.indexOf('content = pos.length ? pos.join'));
    expect(sanitize).toBeLessThan(source.indexOf('if (!contentFile) rejectLikelyWindowsStdinMojibake(content);'));
    expect(sanitize).toBeLessThan(source.indexOf('if (!content.trim())'));
    expect(sanitize).toBeLessThan(source.indexOf('report: content'));
    expect(sanitize).toBeLessThan(source.indexOf('body: { dispatchRoot: dispatchRootCandidate, content }'));
    expect(sanitize).toBeLessThan(source.indexOf('const paras = buildReportContent({'));
  });

  it('routes through the authenticated source daemon when the host secret is available', () => {
    const source = reportCommandSource();

    expect(source).toContain('response = await postCurrentSessionDaemonRoute({');
    expect(source).toContain('path: REPORT_SESSION_RELAY_ROUTE');
    expect(source).not.toContain(
      'response = await fetch(`http://127.0.0.1:${targetDaemon.ipcPort}/api/trigger`',
    );
  });

  it('does not require the isolated CLI to read the dispatch registry', () => {
    const source = reportCommandSource();

    expect(source).not.toContain("orchestrate-dispatch.json");
    expect(source).not.toContain('findDispatchRegistryEntry({');
  });

  it('creates the dispatch seed in the authenticated daemon before returning the root id', () => {
    const dispatchSource = dispatchCommandSource();
    const daemonSource = readFileSync(resolve('src/daemon.ts'), 'utf8');

    expect(dispatchSource).toContain('path: DISPATCH_REPORT_REGISTER_ROUTE');
    expect(dispatchSource).toContain('seedText: built.seedText');
    expect(dispatchSource).toContain('seedId = registrationBody?.dispatchRoot');
    expect(dispatchSource).not.toContain('const seedId = await sendMessage(appId, targetChatId, built.seedText');
    expect(daemonSource).toContain("sendMessage(ds.larkAppId, targetChatId, seedText, 'text')");
  });
});
