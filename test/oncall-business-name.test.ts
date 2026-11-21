import { expect, it, vi } from 'vitest';
import { readOncallBusinessName } from '../src/services/oncall-platform.js';
const target = { tenantId: 12, endpoint: 'https://gateway.example.test/api/v1/oncall_platform/api/inf/v1/chat/', emailDomain: 'example.test' };

it('reads the official tenant name with service authentication and verifies the tenant identity', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 0, data: { id: 12, name: '测试业务线' } }));
  expect(await readOncallBusinessName(target, 'test-secret', fetcher)).toBe('测试业务线');
  expect(fetcher.mock.calls[0][0]).toBe('https://gateway.example.test/api/v1/oncall_platform/api/inf/v1/tenant/12/info');
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer test-secret');
  fetcher.mockResolvedValueOnce(Response.json({ code: 0, data: { id: 56, name: '其他业务线' } }));
  await expect(readOncallBusinessName(target, 'test-secret', fetcher)).rejects.toThrow('业务线信息无效');
});
