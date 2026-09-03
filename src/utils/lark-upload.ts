/**
 * Minimal Lark image uploader callable from worker process.
 * Worker doesn't load bot-registry — it gets larkAppId/larkAppSecret/brand from
 * the daemon's init message (see worker-pool.ts forkWorker / worker.ts init).
 */
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import * as Lark from '@larksuiteoapi/node-sdk';
import { type Brand, sdkDomain } from '../im/lark/lark-hosts.js';

/** Bound both tenant-token acquisition and image upload so a stalled Lark
 * request cannot occupy the worker's screenshot single-flight indefinitely. */
const UPLOAD_TIMEOUT_MS = 30_000;

let cachedUploadHttpInstance: any;
function uploadHttpInstance(): any {
  if (cachedUploadHttpInstance !== undefined) return cachedUploadHttpInstance;
  let base: any;
  try {
    // Namespace access (not a named import): a stripped/mocked SDK that omits
    // this export must yield undefined here, not throw before the guard below.
    base = (Lark as unknown as { defaultHttpInstance?: any }).defaultHttpInstance;
  } catch {
    base = undefined;
  }
  if (!base || typeof base.create !== 'function') {
    cachedUploadHttpInstance = null;
    return cachedUploadHttpInstance;
  }
  const instance = base.create({ timeout: UPLOAD_TIMEOUT_MS });
  try {
    for (const handler of base.interceptors?.request?.handlers ?? []) {
      if (handler) {
        instance.interceptors.request.use(handler.fulfilled, handler.rejected, {
          synchronous: handler.synchronous,
        });
      }
    }
    for (const handler of base.interceptors?.response?.handlers ?? []) {
      if (handler) instance.interceptors.response.use(handler.fulfilled, handler.rejected);
    }
  } catch {
    cachedUploadHttpInstance = null;
    return cachedUploadHttpInstance;
  }
  cachedUploadHttpInstance = instance;
  return cachedUploadHttpInstance;
}

let cached: { client: any; appId: string; brand: Brand } | null = null;

function getClient(appId: string, secret: string, brand: Brand) {
  // 缓存 key 含 brand：同 appId 不同 brand 不复用打错域的客户端。
  if (cached && cached.appId === appId && cached.brand === brand) return cached.client;
  const httpInstance = uploadHttpInstance();
  cached = {
    appId,
    brand,
    // brand → 域名。Lark bot 截图上传必须打 larksuite.com，否则 image.create 失败。
    client: new Client({
      appId,
      appSecret: secret,
      domain: sdkDomain(brand),
      loggerLevel: LoggerLevel.error,
      ...(httpInstance ? { httpInstance } : {}),
    }),
  };
  return cached.client;
}

export async function uploadImageBuffer(appId: string, secret: string, buf: Buffer, brand: Brand = 'feishu'): Promise<string> {
  const c = getClient(appId, secret, brand);
  const res = await c.im.v1.image.create({
    data: { image_type: 'message', image: buf },
  });
  const key = res?.image_key;
  if (!key) throw new Error(`upload failed: ${JSON.stringify(res)}`);
  return key;
}
