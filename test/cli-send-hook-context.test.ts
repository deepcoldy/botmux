import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

describe('cmdSend hook context wiring', () => {
  it('passes the current session id into outbound send/reply hooks', () => {
    expect(cliSource).toContain('const hookContext = {');
    expect(cliSource).toMatch(/sendMessage\(appId,\s*sendTarget\.chatId,\s*content,\s*msgType,\s*undefined,\s*hookContext\)/);
    expect(cliSource).toMatch(/replyMessage\(appId,\s*sendTarget\.rootMessageId,\s*content,\s*msgType,\s*true,\s*undefined,\s*hookContext\)/);
  });
});

describe('relaySend outbox privacy', () => {
  it('writes relay payload files with private permissions', () => {
    const relayIdx = cliSource.indexOf('async function relaySend(');
    expect(relayIdx).toBeGreaterThanOrEqual(0);
    const cmdSendIdx = cliSource.indexOf('async function cmdSend(');
    const region = cliSource.slice(relayIdx, cmdSendIdx);
    expect(region).toContain("writeFileSync(cfile, content, { mode: 0o600 })");
    expect(region).toContain("writeFileSync(join(relayDir, base), readFileSync(p), { mode: 0o600 })");
    expect(region).toContain("atomicWriteFileSync(join(relayDir, `${id}.req.json`), JSON.stringify({ contentFile: contentBase, attachments, videos, videoCovers, flags }), { mode: 0o600 })");
  });
});
