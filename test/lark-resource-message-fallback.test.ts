import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { Client } from '@larksuiteoapi/node-sdk';

const mocks = vi.hoisted(() => ({ request: vi.fn(), userToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', brand: 'feishu' } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));
vi.mock('../src/utils/user-token.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/user-token.js')>(),
  resolveUserToken: mocks.userToken,
}));

import { downloadMessageResource, UserTokenMissingError } from '../src/im/lark/client.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { downloadResources } from '../src/core/session-manager.js';
import type { LarkMessage } from '../src/types.js';

const dirs: string[] = [];
const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
function mismatch(data: unknown = { code: 234003, msg: 'File not in msg.' }) {
  return Object.assign(new Error('resource not in message'), { response: { status: 400, data } });
}
async function outputPath() {
  const dir = await mkdtemp(join(tmpdir(), 'botmux-resource-message-'));
  dirs.push(dir);
  return join(dir, 'attachment');
}
function requestedMessages() {
  return mocks.request.mock.calls.map(([request]) =>
    /\/messages\/([^/]+)\/resources\//.exec(request.url)?.[1]);
}
async function forwardedResource(nested = false, outer = false) {
  const parsed: LarkMessage = {
    messageId: 'om_root', rootId: '', senderId: 'ou_sender', senderType: 'user',
    msgType: 'merge_forward', content: '[合并转发消息]', createTime: '0',
  };
  return expandMergeForward('cli_test', 'om_root', parsed, undefined, {
    items: [
      { message_id: 'om_root', msg_type: 'merge_forward', body: { content: '{}' } },
      ...(outer ? [{ message_id: 'om_outer', upper_message_id: 'om_root',
        msg_type: 'merge_forward', sender: { id: 'ou_sender', sender_type: 'user' },
        body: { content: '{}' } }] : []),
      ...(nested ? [{ message_id: 'om_inner', upper_message_id: outer ? 'om_outer' : 'om_root',
        msg_type: 'merge_forward', sender: { id: 'ou_sender', sender_type: 'user' },
        body: { content: '{}' } }] : []),
      { message_id: 'om_child', upper_message_id: nested ? 'om_inner' : 'om_root',
        msg_type: 'image', sender: { id: 'ou_sender', sender_type: 'user' },
        body: { content: JSON.stringify({ image_key: 'img_test' }) } },
    ],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.userToken.mockResolvedValue(null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('forwarded resource message ownership', () => {
  it.each([false, true])('downloads from the owning sub-message (nested=%s) without OAuth', async nested => {
    const { extraResources } = await forwardedResource(nested);
    mocks.request.mockRejectedValueOnce(mismatch(Readable.from(['{"code":234003}'])));
    mocks.request.mockResolvedValueOnce(bytes);

    const result = await downloadResources('cli_test', 'om_root', extraResources, 'ou_sender');

    expect(result.needLogin).toBe(false);
    expect(result.attachments).toHaveLength(1);
    expect(await readFile(result.attachments[0].path)).toEqual(bytes);
    expect(requestedMessages()).toEqual(['om_root', 'om_child']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('keeps the parent download path when it already works', async () => {
    const { extraResources } = await forwardedResource();
    mocks.request.mockResolvedValue(bytes);

    const result = await downloadResources('cli_test', 'om_root', extraResources, 'ou_sender');

    expect(result.attachments).toHaveLength(1);
    expect(result.needLogin).toBe(false);
    expect(requestedMessages()).toEqual(['om_root']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('can use the enclosing nested forward when neither root nor leaf owns the resource', async () => {
    const { extraResources } = await forwardedResource(true);
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockResolvedValueOnce(bytes);

    const result = await downloadResources('cli_test', 'om_root', extraResources, 'ou_sender');

    expect(result.attachments).toHaveLength(1);
    expect(result.needLogin).toBe(false);
    expect(requestedMessages()).toEqual(['om_root', 'om_child', 'om_inner']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('does not request login when every known message returns 234003', async () => {
    const { extraResources } = await forwardedResource();
    mocks.request.mockImplementation(async () => { throw mismatch(); });

    const result = await downloadResources('cli_test', 'om_root', extraResources, 'ou_sender');

    expect(result).toEqual({ attachments: [], needLogin: false });
    expect(requestedMessages()).toEqual(['om_root', 'om_child']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('retains intermediate ancestors in a deeply nested forward', async () => {
    const { extraResources } = await forwardedResource(true, true);
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockResolvedValueOnce(bytes);

    const result = await downloadResources('cli_test', 'om_root', extraResources, 'ou_sender');

    expect(result.attachments).toHaveLength(1);
    expect(result.needLogin).toBe(false);
    expect(requestedMessages()).toEqual(['om_root', 'om_child', 'om_inner', 'om_outer']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
});

describe('resource fallback classification and identity', () => {
  it.each([false, true])('resolves streamed SDK ownership errors and preserves Range transfers (ranged=%s)', async ranged => {
    const output = await outputPath();
    const requests: Array<{ message: string; range?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/auth/')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 'test-app-token', expire: 7200 }));
        return;
      }
      const message = /\/messages\/([^/]+)\/resources\//.exec(req.url ?? '')?.[1] ?? '';
      requests.push({ message, range: req.headers.range, authorization: req.headers.authorization });
      if (message === 'om_root') {
        res.writeHead(400);
        res.end('{"code":234003,"msg":"File not in msg."}');
      } else if (ranged && !req.headers.range) {
        res.writeHead(400);
        res.end('{"code":234037}');
      } else if (req.headers.range) {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range)!;
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}` });
        res.end(bytes.subarray(Number(start), Number(end) + 1));
      } else {
        res.setHeader('content-type', 'image/gif');
        res.end(bytes);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const noop = () => {};
      const client = new Client({ appId: 'cli_resource_fixture', appSecret: 'test-only',
        domain: `http://127.0.0.1:${address.port}`,
        logger: { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop },
      });
      mocks.request.mockImplementation(request => client.request(request));

      await downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', output, 'ou_sender', {
        fallbackMessageIds: ['om_child'],
      });

      expect(await readFile(output)).toEqual(bytes);
      expect(requests.map(request => request.message)).toEqual(ranged
        ? ['om_root', 'om_child', 'om_child', 'om_child'] : ['om_root', 'om_child']);
      if (ranged) expect(requests.map(request => request.range))
        .toEqual([undefined, undefined, 'bytes=0-0', `bytes=0-${bytes.length - 1}`]);
      expect(requests.every(request => request.authorization === 'Bearer test-app-token')).toBe(true);
      expect(mocks.userToken).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([
    () => ({ code: 234003 }),
    () => '{"code":234003}',
    () => Buffer.from('{"code":234003}'),
    () => Readable.from(['{"code":', '234003}']),
  ])('does not borrow a user token for a resource mismatch without alternate IDs', async data => {
    const error = mismatch(data());
    mocks.request.mockRejectedValueOnce(error);

    await expect(downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', await outputPath()))
      .rejects.toBe(error);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it.each(['image', 'file', 'video'] as const)('retries %s with the same resource key and API resource type', async type => {
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockResolvedValueOnce(bytes);
    const output = await outputPath();

    await downloadMessageResource('cli_test', 'om_root', 'resource_test', type, output, 'ou_sender', {
      fallbackMessageIds: ['om_root', 'om_child', 'om_child'],
    });

    expect(await readFile(output)).toEqual(bytes);
    expect(requestedMessages()).toEqual(['om_root', 'om_child']);
    expect(mocks.request.mock.calls.every(([request]) =>
      request.url.endsWith('/resources/resource_test')
      && request.params.type === (type === 'video' ? 'file' : type))).toBe(true);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('preserves genuine permission fallback without trying a different message', async () => {
    mocks.request.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));

    await expect(downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', await outputPath(), 'ou_sender', {
      fallbackMessageIds: ['om_child'],
    })).rejects.toBeInstanceOf(UserTokenMissingError);
    expect(requestedMessages()).toEqual(['om_root']);
    expect(mocks.userToken).toHaveBeenCalledWith('cli_test', 'test-only', 'feishu', 'ou_sender');
  });

  it('uses the resolved child message for a genuine user-token fallback', async () => {
    mocks.request.mockRejectedValueOnce(mismatch());
    mocks.request.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    mocks.userToken.mockResolvedValue('test-user-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
    const output = await outputPath();

    await downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', output, 'ou_sender', {
      fallbackMessageIds: ['om_child'],
    });

    expect(await readFile(output)).toEqual(bytes);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/messages/om_child/resources/img_test');
    expect(mocks.userToken).toHaveBeenCalledWith('cli_test', 'test-only', 'feishu', 'ou_sender');
  });

  it('does not retry server failures or convert them into login prompts', async () => {
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    mocks.request.mockRejectedValueOnce(error);

    await expect(downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', await outputPath(), undefined, {
      fallbackMessageIds: ['om_child'],
    })).rejects.toBe(error);
    expect(requestedMessages()).toEqual(['om_root']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('keeps passive history app-only while resolving message ownership', async () => {
    mocks.request.mockRejectedValueOnce(mismatch());
    const denied = Object.assign(new Error('forbidden'), { status: 403 });
    mocks.request.mockRejectedValueOnce(denied);

    await expect(downloadMessageResource('cli_test', 'om_root', 'img_test', 'image', await outputPath(), undefined, {
      fallbackMessageIds: ['om_child'], allowUserTokenFallback: false,
    })).rejects.toBe(denied);
    expect(requestedMessages()).toEqual(['om_root', 'om_child']);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
});
