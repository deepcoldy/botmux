import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { configureWecom, createWecomPrompter, runWecomSetup } from '../src/cli/wecom/manual-setup.js';
import { commitWecomConfiguration, parseWecomConfig, readWecomCredentialFile, loadWecomSecret } from '../src/im/wecom/config/config.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-setup-')); roots.push(root);
  const file = join(root, 'wecom', 'config.json');
  const output: string[] = [];
  const values = { botId: 'bot-id', secret: 'sensitive-secret-value', allowedUsers: ['alice'], cli: 'codex', backend: 'pty', workingDirectory: root, port: '19123' };
  const prompt = { write: (message: string) => { output.push(message); }, ask: vi.fn(async (): Promise<string | null> => null) };
  const setup = (more: Partial<Parameters<typeof configureWecom>[0]> = {}) => configureWecom({ file, prompt, values, nonInteractive: true, confirm: true, validateCli: async () => true, ...more });
  return { root, file, output, prompt, values, setup };
}
describe('企微配置事务与凭据', () => {
  it('首用不创建飞书配置，保存独立0600凭据与专用core配置且不输出secret', async () => {
    const f = fixture(); await f.setup();
    const config = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    expect(config.managedCore).toMatchObject({ cli: 'codex', backend: 'pty', workingDirectory: f.root, port: 19123 });
    expect(loadWecomSecret(config)).toBe(f.values.secret);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(statSync(config.secretFile!).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, 'wecom', 'credentials')).mode & 0o777).toBe(0o700);
    expect(readFileSync(f.file, 'utf8')).not.toContain(f.values.secret);
    expect(f.output.join('\n')).not.toContain(f.values.secret);
    expect(existsSync(join(f.root, 'bots.json'))).toBe(false);
  });
  it('确认前取消不创建配置目录；编辑取消保留旧配置和secret', async () => {
    const f = fixture();
    expect(await f.setup({ confirm: false, nonInteractive: false })).toBe('cancelled');
    expect(existsSync(join(f.root, 'wecom'))).toBe(false);
    await f.setup(); const original = readFileSync(f.file, 'utf8');
    expect(await f.setup({ confirm: false, nonInteractive: false })).toBe('cancelled');
    expect(readFileSync(f.file, 'utf8')).toBe(original);
    expect(loadWecomSecret(parseWecomConfig(JSON.parse(original)))).toBe(f.values.secret);
  });
  it('新secret落盘但config提交失败时回滚新代并保留旧配置', async () => {
    const f = fixture(); await f.setup(); const original = readFileSync(f.file, 'utf8');
    const config = parseWecomConfig(JSON.parse(original));
    await expect(commitWecomConfiguration({ file: f.file, previous: original, config, newSecret: 'replacement-secret', write: (path, data, opts) => {
      if (path === f.file) throw new Error('disk full');
      atomicWriteFileSync(path, data, opts);
    } })).rejects.toThrow('disk full');
    expect(readFileSync(f.file, 'utf8')).toBe(original);
    expect(readdirSync(join(f.root, 'wecom', 'credentials'))).toHaveLength(1);
    expect(loadWecomSecret(config)).toBe(f.values.secret);
  });
  it('config rename已提交但flush失败时，不删除新config引用的凭据', async () => {
    const f = fixture(); await f.setup(); const original = readFileSync(f.file, 'utf8'); const config = parseWecomConfig(JSON.parse(original));
    await expect(commitWecomConfiguration({ file: f.file, previous: original, config, newSecret: 'replacement-secret', write: (path, data, opts) => {
      atomicWriteFileSync(path, data, opts); if (path === f.file) throw new Error('directory flush failed');
    } })).rejects.toThrow('directory flush failed');
    expect(loadWecomSecret(parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8'))))).toBe('replacement-secret');
    expect(loadWecomSecret(config)).toBe(f.values.secret);
  });
  it('实际文件锁与快照CAS阻止两个并发向导覆盖彼此配置', async () => {
    const f = fixture(); await f.setup(); const previous = readFileSync(f.file, 'utf8'); const config = parseWecomConfig(JSON.parse(previous));
    const results = await Promise.allSettled([
      commitWecomConfiguration({ file: f.file, previous, config, newSecret: 'one' }),
      commitWecomConfiguration({ file: f.file, previous, config, newSecret: 'two' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(join(f.root, 'wecom', 'credentials'))).toHaveLength(2);
  });
  it('兼容旧secretEnv，留空secret编辑不会泄漏或复制环境凭据', async () => {
    const f = fixture(); await f.setup(); const config = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    delete config.secretFile; config.secretEnv = 'OLD_WECOM_SECRET'; writeFileSync(f.file, JSON.stringify(config));
    vi.stubEnv('OLD_WECOM_SECRET', 'legacy-sensitive-value');
    expect(loadWecomSecret(config)).toBe('legacy-sensitive-value');
    await f.setup({ values: { ...f.values, secret: '' } });
    const updated = parseWecomConfig(JSON.parse(readFileSync(f.file, 'utf8')));
    expect(updated.secretEnv).toBe('OLD_WECOM_SECRET'); expect(updated.secretFile).toBeUndefined();
    expect(f.output.join('\n')).not.toContain('legacy-sensitive-value');
  });
  it('旧外部core默认保留；显式迁移使用独立bridge状态且保留原状态', async () => {
    const f = fixture(); await f.setup(); const external = JSON.parse(readFileSync(f.file, 'utf8'));
    delete external.managedCore; external.stateDir = join(f.root, 'old-bridge');
    writeFileSync(f.file, JSON.stringify(external));
    await f.setup({ values: { ...f.values, secret: '' } });
    const kept = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(kept.managedCore).toBeUndefined(); expect(kept.stateDir).toBe(external.stateDir);
    await f.setup({ manageCore: true, values: { ...f.values, secret: '' } });
    const migrated = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(migrated.managedCore).toBeTruthy(); expect(migrated.stateDir).not.toBe(external.stateDir);
  });
  it('拒绝宽权限/链接凭据、通配符以及凭据来源冲突', async () => {
    const f = fixture(); const source = join(f.root, 'secret'); writeFileSync(source, 'secret', { mode: 0o644 });
    expect(() => readWecomCredentialFile(source)).toThrow(/安全凭据文件/); chmodSync(source, 0o600);
    const link = join(f.root, 'link'); symlinkSync(source, link); expect(() => readWecomCredentialFile(link)).toThrow(/安全凭据文件/);
    await expect(f.setup({ values: { ...f.values, allowedUsers: ['*'] } })).rejects.toThrow(/真实企业微信 userid/);
    await f.setup(); const config = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(() => parseWecomConfig({ ...config, secretEnv: 'EXTRA' })).toThrow(/唯一凭据来源/);
  });
});
describe('企微向导输入边界', () => {
  it('非TTY缺参数立即失败，明确userid缺失，完整flags从安全文件取secret不回显', async () => {
    const f = fixture();
    expect(await runWecomSetup([], { tty: false, prompt: f.prompt })).toBe(2);
    expect(f.prompt.ask).not.toHaveBeenCalled();
    const source = join(f.root, 'input-secret'); writeFileSync(source, f.values.secret, { mode: 0o600 });
    const flags = ['--config', f.file, '--bot-id', 'bot-id', '--secret-file', source, '--cli', 'codex', '--backend', 'pty', '--working-dir', f.root, '--core-port', '19123', '--yes'];
    expect(await runWecomSetup(flags, { tty: false, prompt: f.prompt })).toBe(2);
    expect(f.output.join('\n')).toContain('userid');
    expect(await runWecomSetup([...flags, '--allow-user', 'alice'], { tty: false, prompt: f.prompt })).toBe(0);
    expect(f.output.join('\n')).not.toContain(f.values.secret);
  });
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
