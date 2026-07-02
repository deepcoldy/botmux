// `botmux bind <blob>` —— 把这台机器绑定到中心化平台。
// <blob> 是平台网页生成的自包含凭证（内含平台地址 + 绑定 token），
// 因此本仓库源码里不出现任何平台域名。
import { randomBytes } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { readPlatformBinding, writePlatformBinding } from './binding.js';
import { callDashboard } from '../cli/dashboard-endpoint.js';
import { readGlobalConfig, mergeGlobalConfig } from '../global-config.js';

/** 解码平台生成的 bind blob：base64url(JSON{u:平台地址, t:绑定token})。 */
function decodeBindBlob(blob: string): { platformUrl: string; token: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'));
    if (obj && typeof obj.u === 'string' && typeof obj.t === 'string') {
      return { platformUrl: obj.u.replace(/\/$/, ''), token: obj.t };
    }
  } catch {
    /* not a blob */
  }
  return null;
}

export async function cmdBind(args: string[]): Promise<void> {
  let arg = '';
  let platformOverride = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform' || a === '-p') platformOverride = args[++i] || '';
    else if (a.startsWith('--platform=')) platformOverride = a.slice('--platform='.length);
    else if (!a.startsWith('-') && !arg) arg = a;
  }
  if (!arg) {
    console.error('用法: botmux bind <绑定凭证>');
    console.error('  到平台网页「绑定新机器」复制完整命令执行即可。');
    process.exit(1);
    return;
  }

  // 优先把参数当自包含 blob 解（内含平台地址）；否则回退「裸 token + 显式平台地址」
  const decoded = decodeBindBlob(arg);
  let platformUrl: string;
  let code: string;
  if (decoded) {
    platformUrl = decoded.platformUrl;
    code = decoded.token;
  } else {
    platformUrl = (platformOverride || process.env.BOTMUX_PLATFORM_URL || '').replace(/\/$/, '');
    code = arg;
    if (!platformUrl) {
      console.error('绑定凭证无法解析；请用平台网页给出的完整 `botmux bind <凭证>` 命令。');
      process.exit(1);
      return;
    }
  }

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
    // Node 的 fetch 把真正的网络原因塞在 e.cause 里，String(e) 只剩裸 "TypeError: fetch failed"，
    // 对排查毫无帮助。把 cause（ENOTFOUND/ECONNREFUSED/超时/证书等）一并打出来。
    const cause = (e as { cause?: unknown })?.cause;
    const detail = cause ? `${String(e)} —— ${String(cause)}` : String(e);
    console.error(`连接平台失败（${platformUrl}）: ${detail}`);
    console.error('  多为临时网络抖动或平台正在发布；请确认本机能访问平台域名后重试 `botmux bind`（重绑安全、幂等，机器身份不变）。');
    process.exit(1);
    return;
  }

  const body = (await res.json().catch(() => ({}))) as { machineId?: string; machineToken?: string; error?: string };
  if (!res.ok || !body.machineToken) {
    const reason = body.error || `HTTP ${res.status}`;
    console.error(`绑定失败: ${reason}`);
    if (reason.includes('invalid') || reason.includes('expired')) console.error('  绑定凭证无效或已过期，请回平台重新生成。');
    process.exit(1);
    return;
  }

  writePlatformBinding({
    platformUrl,
    machineId: body.machineId || machineId,
    machineToken: body.machineToken,
    name,
  });

  // 绑定平台即「默认打开远程访问开关」：之后 dashboard / 终端 / webhook 链接都走中心化平台
  // 机器子域，而非本机 host:port。只在用户从未显式设置过时写入——已显式开/关的尊重用户选择
  // （重绑不覆盖）。开关本身仍可在 dashboard 设置里随时改。
  if (readGlobalConfig().remoteAccess === undefined) {
    mergeGlobalConfig({ remoteAccess: true });
  }

  console.log(`✓ 已绑定到平台 ${platformUrl}`);
  console.log(`  机器名: ${name}`);

  // 事件驱动：写完绑定后直接「捅一下」正在运行的 daemon（走其本地 /__cli HMAC 接口，
  // 复用端口自发现），立即重连平台，无需重启、不轮询。没 daemon 在跑则跳过——下次启动自然读到绑定。
  const configDir = join(homedir(), '.botmux');
  const poke = await callDashboard({
    configDir,
    defaultPort: 7891,
    envPort: process.env.BOTMUX_DASHBOARD_PORT,
    path: '/__cli/reload-binding',
  });
  if (poke.ok) {
    console.log('  已通知运行中的 botmux 连接平台 ✓（无需重启）');
    // reload-binding 已让 dashboard 进程刷新配置缓存，此处读到的就是中心化平台 dashboard 链接。
    const cur = await callDashboard({
      configDir,
      defaultPort: 7891,
      envPort: process.env.BOTMUX_DASHBOARD_PORT,
      path: '/__cli/current',
    });
    if (cur.ok) {
      console.log(`  面板: ${cur.url}`);
    } else {
      console.log('  面板: 运行 `botmux dashboard` 获取中心化平台链接。');
    }
  } else {
    console.log('  未发现运行中的 botmux —— 启动它即可连接平台并在网页打开本机 dashboard。');
  }
}
