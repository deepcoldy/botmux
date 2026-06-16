// `botmux bind <code>` —— 把这台机器绑定到中心化平台。
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { readPlatformBinding, writePlatformBinding } from './binding.js';

const DEFAULT_PLATFORM_URL = process.env.BOTMUX_PLATFORM_URL || 'https://botmux.bytedance.net';

export async function cmdBind(args: string[]): Promise<void> {
  let code = '';
  let platformUrl = DEFAULT_PLATFORM_URL;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform' || a === '-p') {
      platformUrl = args[++i] || platformUrl;
    } else if (a.startsWith('--platform=')) {
      platformUrl = a.slice('--platform='.length);
    } else if (!a.startsWith('-') && !code) {
      code = a;
    }
  }
  if (!code) {
    console.error('用法: botmux bind <绑定码> [--platform <平台地址>]');
    console.error('  绑定码在平台网页「绑定新机器」处获取。');
    process.exit(1);
  }
  platformUrl = platformUrl.replace(/\/$/, '');

  // 复用已有 machineId（重绑保持机器身份不变）
  const existing = readPlatformBinding();
  const machineId = existing?.machineId || randomBytes(8).toString('hex');
  const name = existing?.name || hostname();

  let res: Response;
  try {
    res = await fetch(`${platformUrl}/api/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, machineId }),
    });
  } catch (e) {
    console.error(`连接平台失败（${platformUrl}）: ${String(e)}`);
    process.exit(1);
    return;
  }

  const body = (await res.json().catch(() => ({}))) as { machineId?: string; machineToken?: string; error?: string };
  if (!res.ok || !body.machineToken) {
    const reason = body.error || `HTTP ${res.status}`;
    console.error(`绑定失败: ${reason}`);
    if (reason === 'expired' || reason === 'invalid') console.error('  绑定码无效或已过期，请回平台重新生成。');
    process.exit(1);
    return;
  }

  writePlatformBinding({
    platformUrl,
    machineId: body.machineId || machineId,
    machineToken: body.machineToken,
    name,
  });

  console.log(`✓ 已绑定到平台 ${platformUrl}`);
  console.log(`  机器名: ${name}`);
  console.log('  运行 `botmux dashboard` 后，平台即可看到并打开这台机器的 dashboard。');
}
