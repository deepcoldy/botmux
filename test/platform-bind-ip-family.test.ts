// test/platform-bind-ip-family.test.ts
// botmux bind 的协议族兜底链：默认路径不通 → 依次 IPv6 / IPv4 重试，
// 但不再把 ipFamily 写进绑定文件（隧道始终用 happy-eyeballs 自动选路）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const postJson = vi.fn();
vi.mock('../src/platform/platform-http.js', () => ({
  postJson: (...a: unknown[]) => postJson(...a),
}));

const readPlatformBinding = vi.fn();
const writePlatformBinding = vi.fn();
vi.mock('../src/platform/binding.js', () => ({
  readPlatformBinding: (...a: unknown[]) => readPlatformBinding(...a),
  writePlatformBinding: (...a: unknown[]) => writePlatformBinding(...a),
}));

vi.mock('../src/cli/dashboard-endpoint.js', () => ({ callDashboard: vi.fn(async () => ({ ok: false })) }));
vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({ remoteAccess: true })),
  mergeGlobalConfig: vi.fn(),
}));

import { cmdBind } from '../src/platform/bind.js';

const blob = Buffer.from(JSON.stringify({ u: 'http://platform.test', t: 'code-1' })).toString('base64url');
const okRes = { status: 200, json: { machineId: 'm-1', machineToken: 'tok-1' } };
const netErr = () => Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' });
const hostOnly = { isAgentContext: () => false };

// 清理 process.exitCode 必须赋 `0`，不能赋 `undefined`。
// 这是 Bun 的限制（实测 bun 1.4.0）：`process.exitCode` 的 setter 对 `undefined`
// 是 no-op，赋值后读回来仍是旧值；赋 `0` 才真正清除。Node 两者都清除，所以
// vitest 下写 `undefined` 看不出问题。
//   node -e 'process.exitCode=2; process.exitCode=undefined' → 读到 undefined，exit 0
//   bun  -e 'process.exitCode=2; process.exitCode=undefined' → 读到 2，        exit 2
//   bun  -e 'process.exitCode=2; process.exitCode=0'         → 读到 0，        exit 0
// 下面第 5 条用例走 src/platform/bind.ts 的 managed-agent 拒绝分支，那里正确地
// 设了 `process.exitCode = 2`。若清理用 `undefined`，这个 2 会在 Bun 下一路活到
// 进程退出：文件本身「5 pass 0 fail」，但 bun 进程 exit 2，而
// scripts/run-bun-tests.mjs 的 `code !== 0` 判定在解析 `Ran N tests` 之前，
// 于是零失败断言的文件会纯粹因为泄漏的退出码被判红。
// 注意别改成 `delete process.exitCode`：Bun 下会抛 TypeError: Unable to delete property。
describe('cmdBind 协议族兜底（不落盘 ipFamily）', () => {
  beforeEach(() => {
    postJson.mockReset();
    readPlatformBinding.mockReset().mockReturnValue(null);
    writePlatformBinding.mockReset();
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('默认路径成功：不写 ipFamily', async () => {
    postJson.mockResolvedValueOnce(okRes);
    await cmdBind([blob], hostOnly);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect((postJson.mock.calls[0][2] as { family?: number }).family).toBeUndefined();
    expect(writePlatformBinding).toHaveBeenCalledTimes(1);
    expect(writePlatformBinding.mock.calls[0][0]).not.toHaveProperty('ipFamily');
  });

  it('默认不通、IPv6 兜底成功：不写 ipFamily', async () => {
    postJson.mockRejectedValueOnce(netErr()).mockResolvedValueOnce(okRes);
    await cmdBind([blob], hostOnly);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect((postJson.mock.calls[1][2] as { family?: number }).family).toBe(6);
    expect(writePlatformBinding.mock.calls[0][0]).not.toHaveProperty('ipFamily');
    expect(writePlatformBinding.mock.calls[0][0]).toMatchObject({ machineToken: 'tok-1' });
  });

  it('默认与 IPv6 都不通、IPv4 兜底成功：不写 ipFamily', async () => {
    postJson.mockRejectedValueOnce(netErr()).mockRejectedValueOnce(netErr()).mockResolvedValueOnce(okRes);
    await cmdBind([blob], hostOnly);
    expect(postJson).toHaveBeenCalledTimes(3);
    expect((postJson.mock.calls[2][2] as { family?: number }).family).toBe(4);
    expect(writePlatformBinding.mock.calls[0][0]).not.toHaveProperty('ipFamily');
  });

  it('三路全不通：报错退出、不写绑定', async () => {
    postJson.mockRejectedValue(netErr());
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(cmdBind([blob], hostOnly)).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(postJson).toHaveBeenCalledTimes(3);
    expect(writePlatformBinding).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('managed agent context is rejected before consuming the blob or touching network/storage', async () => {
    await cmdBind([blob], { isAgentContext: () => true });

    expect(process.exitCode).toBe(2);
    expect(postJson).not.toHaveBeenCalled();
    expect(readPlatformBinding).not.toHaveBeenCalled();
    expect(writePlatformBinding).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('宿主终端'));
  });
});
