// test/platform-bind-ip-family.test.ts
// botmux bind 的协议族兜底链：默认路径不通 → 依次 IPv6 / IPv4 重试，
// 兜底成功把 ipFamily 记进绑定文件；默认路径成功则不记（重绑清掉过期偏好）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('cmdBind 协议族兜底', () => {
  beforeEach(() => {
    postJson.mockReset();
    readPlatformBinding.mockReset().mockReturnValue(null);
    writePlatformBinding.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('默认路径成功：不落 ipFamily', async () => {
    postJson.mockResolvedValueOnce(okRes);
    await cmdBind([blob]);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect((postJson.mock.calls[0][2] as { family?: number }).family).toBeUndefined();
    expect(writePlatformBinding).toHaveBeenCalledTimes(1);
    expect(writePlatformBinding.mock.calls[0][0]).not.toHaveProperty('ipFamily');
  });

  it('默认不通、IPv6 兜底成功：落 ipFamily: 6', async () => {
    postJson.mockRejectedValueOnce(netErr()).mockResolvedValueOnce(okRes);
    await cmdBind([blob]);
    expect(postJson).toHaveBeenCalledTimes(2);
    expect((postJson.mock.calls[1][2] as { family?: number }).family).toBe(6);
    expect(writePlatformBinding.mock.calls[0][0]).toMatchObject({ ipFamily: 6, machineToken: 'tok-1' });
  });

  it('默认与 IPv6 都不通、IPv4 兜底成功：落 ipFamily: 4', async () => {
    postJson.mockRejectedValueOnce(netErr()).mockRejectedValueOnce(netErr()).mockResolvedValueOnce(okRes);
    await cmdBind([blob]);
    expect(postJson).toHaveBeenCalledTimes(3);
    expect((postJson.mock.calls[2][2] as { family?: number }).family).toBe(4);
    expect(writePlatformBinding.mock.calls[0][0]).toMatchObject({ ipFamily: 4 });
  });

  it('三路全不通：报错退出、不写绑定', async () => {
    postJson.mockRejectedValue(netErr());
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(cmdBind([blob])).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(postJson).toHaveBeenCalledTimes(3);
    expect(writePlatformBinding).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
