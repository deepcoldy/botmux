import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createWecomPrompter } from '../src/cli/wecom/prompter.js';
import { commitWecomConfiguration, parseWecomConfig, readWecomCredentialFile, loadWecomSecret, type WecomConfig } from '../src/im/wecom/config/config.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
/** A WeCom configuration committed the way the Dashboard onboarding commits one (commitWecomConfiguration). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-setup-')); roots.push(root);
  const file = join(root, 'wecom', 'config.json');
  const secret = 'sensitive-secret-value';
  const config: WecomConfig = {
    botId: 'bot-id', secretEnv: 'UNUSED_UNTIL_COMMIT', coreUrl: 'http://127.0.0.1:19123', allowedUsers: ['alice'],
    managedCore: { cli: 'codex', backend: 'pty', workingDirectory: root, port: 19123, stateDir: join(root, 'wecom', 'core'), botId: 'local_wecom_fixture' },
  };
  const commit = () => commitWecomConfiguration({ file, previous: undefined, config, newSecret: secret });
  return { root, file, secret, config, commit };
}
describe('企微配置事务与凭据', () => {
  it('首次提交：配置与凭据各为0600、凭据目录0700，配置文件里没有secret', async () => {
    const f = fixture(); await f.commit();
    const config = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    expect(config.managedCore).toMatchObject({ cli: 'codex', backend: 'pty', workingDirectory: f.root, port: 19123 });
    expect(config.secretEnv).toBeUndefined();
    expect(loadWecomSecret(config)).toBe(f.secret);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(statSync(config.secretFile!).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, 'wecom', 'credentials')).mode & 0o777).toBe(0o700);
    expect(readFileSync(f.file, 'utf8')).not.toContain(f.secret);
  });
  it('新secret落盘但config提交失败时回滚新代并保留旧配置', async () => {
    const f = fixture(); await f.commit(); const original = readFileSync(f.file, 'utf8');
    const config = parseWecomConfig(JSON.parse(original));
    await expect(commitWecomConfiguration({ file: f.file, previous: original, config, newSecret: 'replacement-secret', write: (path, data, opts) => {
      if (path === f.file) throw new Error('disk full');
      atomicWriteFileSync(path, data, opts);
    } })).rejects.toThrow('disk full');
    expect(readFileSync(f.file, 'utf8')).toBe(original);
    expect(readdirSync(join(f.root, 'wecom', 'credentials'))).toHaveLength(1);
    expect(loadWecomSecret(config)).toBe(f.secret);
  });
  it('config rename已提交但flush失败时，不删除新config引用的凭据', async () => {
    const f = fixture(); await f.commit(); const original = readFileSync(f.file, 'utf8'); const config = parseWecomConfig(JSON.parse(original));
    await expect(commitWecomConfiguration({ file: f.file, previous: original, config, newSecret: 'replacement-secret', write: (path, data, opts) => {
      atomicWriteFileSync(path, data, opts); if (path === f.file) throw new Error('directory flush failed');
    } })).rejects.toThrow('directory flush failed');
    expect(loadWecomSecret(parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8'))))).toBe('replacement-secret');
    expect(loadWecomSecret(config)).toBe(f.secret);
  });
  it('实际文件锁与快照CAS阻止两个并发向导覆盖彼此配置', async () => {
    const f = fixture(); await f.commit(); const previous = readFileSync(f.file, 'utf8'); const config = parseWecomConfig(JSON.parse(previous));
    const results = await Promise.allSettled([
      commitWecomConfiguration({ file: f.file, previous, config, newSecret: 'one' }),
      commitWecomConfiguration({ file: f.file, previous, config, newSecret: 'two' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(join(f.root, 'wecom', 'credentials'))).toHaveLength(2);
  });
  it('兼容旧secretEnv：不带新secret的编辑保留环境变量来源，不把环境凭据复制成文件', async () => {
    const f = fixture(); await f.commit(); const config = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    delete config.secretFile; config.secretEnv = 'OLD_WECOM_SECRET'; writeFileSync(f.file, JSON.stringify(config), { mode: 0o600 });
    rmSync(join(f.root, 'wecom', 'credentials'), { recursive: true, force: true });
    vi.stubEnv('OLD_WECOM_SECRET', 'legacy-sensitive-value');
    const previous = readFileSync(f.file, 'utf8');
    await commitWecomConfiguration({ file: f.file, previous, config: { ...config, allowedUsers: ['alice', 'bob'] } });
    const updated = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    expect(updated.allowedUsers).toEqual(['alice', 'bob']);
    expect(updated.secretEnv).toBe('OLD_WECOM_SECRET'); expect(updated.secretFile).toBeUndefined();
    expect(loadWecomSecret(updated)).toBe('legacy-sensitive-value');
    expect(existsSync(join(f.root, 'wecom', 'credentials'))).toBe(false);
    expect(readFileSync(f.file, 'utf8')).not.toContain('legacy-sensitive-value');
  });
  it('拒绝宽权限/链接凭据、通配符以及凭据来源冲突', async () => {
    const f = fixture(); const source = join(f.root, 'secret'); writeFileSync(source, 'secret', { mode: 0o644 });
    expect(() => readWecomCredentialFile(source)).toThrow(/安全凭据文件/); chmodSync(source, 0o600);
    const link = join(f.root, 'link'); symlinkSync(source, link); expect(() => readWecomCredentialFile(link)).toThrow(/安全凭据文件/);
    await f.commit(); const config = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(() => parseWecomConfig({ ...config, allowedUsers: ['*'] })).toThrow(/真实企业微信 userid/);
    expect(() => parseWecomConfig({ ...config, secretEnv: 'EXTRA' })).toThrow(/唯一凭据来源/);
  });
});
describe('企微向导输入边界', () => {
  it('真正readline secret输入不会经output流回显字节', async () => {
    const input = new PassThrough() as any; input.isTTY = true; input.setRawMode = vi.fn();
    const output = new PassThrough() as any; let rendered = ''; output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });
    const prompt = createWecomPrompter(input, output); const answer = prompt.ask('Secret（不回显）', { hidden: true });
    input.write('highly-sensitive-password\r');
    expect(await answer).toBe('highly-sensitive-password');
    expect(rendered).not.toContain('highly-sensitive-password'); expect(rendered).toContain('Secret');
    expect(input.setRawMode).toHaveBeenCalled(); input.destroy(); output.destroy();
  });
});
