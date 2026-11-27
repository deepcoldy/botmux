import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
function response() { const res = { writeHead: vi.fn(), end: vi.fn() }; return res as typeof res & ServerResponse; }
describe('企微Dashboard独立管理API', () => {
  it('读取也需要主机管理员身份，写入另外需要控制CSRF', async () => {
    const manager = { list: vi.fn(async () => []), start: vi.fn(), stop: vi.fn() };
    for (const method of ['GET', 'POST']) {
      const res = response();
      await handleWecomConnectionsApi({ method } as IncomingMessage, res, new URL('http://localhost/api/wecom/connections'), { manager, hostAdmin: false, csrfValid: true });
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    }
    const res = response();
    await handleWecomConnectionsApi({ method: 'POST' } as IncomingMessage, res, new URL(`http://localhost/api/wecom/connections/${'a'.repeat(64)}/start`), { manager, hostAdmin: true, csrfValid: false });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(manager.list).not.toHaveBeenCalled(); expect(manager.start).not.toHaveBeenCalled(); expect(manager.stop).not.toHaveBeenCalled();
  });
  it('仅接受发现索引中的hash标识，不向manager传浏览器路径/配置/秘密', async () => {
    const id = 'a'.repeat(64); const manager = { list: vi.fn(async () => []), start: vi.fn(async () => ({ id })), stop: vi.fn(async () => ({ id })) } as any;
    const res = response();
    await handleWecomConnectionsApi({ method: 'POST' } as IncomingMessage, res, new URL(`http://localhost/api/wecom/connections/${id}/start`), { manager, hostAdmin: true, csrfValid: true });
    expect(manager.start).toHaveBeenCalledExactlyOnceWith(id); expect(res.writeHead).toHaveBeenCalledWith(202, expect.anything());
    const invalid = response();
    await handleWecomConnectionsApi({ method: 'POST' } as IncomingMessage, invalid, new URL('http://localhost/api/wecom/connections/credential-file/stop'), { manager, hostAdmin: true, csrfValid: true });
    expect(invalid.writeHead).toHaveBeenCalledWith(404, expect.anything()); expect(manager.stop).not.toHaveBeenCalled();
  });
  it('错误只输出受限代码，不回传底层异常中的Secret/路径', async () => {
    const manager = { list: async () => { throw new Error('sensitive-secret /private/credential-path'); }, start: vi.fn(), stop: vi.fn() };
    const res = response();
    await handleWecomConnectionsApi({ method: 'GET' } as IncomingMessage, res, new URL('http://localhost/api/wecom/connections'), { manager, hostAdmin: true, csrfValid: true });
    const body = String(res.end.mock.calls[0][0]); expect(body).toContain('wecom_operation_failed'); expect(body).not.toContain('sensitive-secret'); expect(body).not.toContain('/private');
  });
});
