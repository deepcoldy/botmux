import type { ScreenStatus } from '../types.js';

const STREAM_ID_RE = /^cs_[0-9a-f]{32}$/;
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]{8,256}$/;

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function required(args: string[], flag: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = flagValue(args, flag);
  if (!value || value.startsWith('--')) return { ok: false, error: `${flag} 需要参数` };
  return { ok: true, value };
}

export type CardRuntimeStatusParsedArgs =
  | {
      ok: true;
      operation: 'bind-runtime';
      streamId: string;
      statusElementId: string;
      imageElementId: string;
      activeImageKey: string;
      inactiveImageKey: string;
      labels?: Partial<Record<ScreenStatus, string>>;
      sessionId?: string;
    }
  | { ok: true; operation: 'unbind-runtime'; streamId: string; sessionId?: string }
  | { ok: false; error: string };

export function parseCardRuntimeStatusArgs(args: string[]): CardRuntimeStatusParsedArgs {
  const operation = args[0];
  if (operation !== 'bind-runtime' && operation !== 'unbind-runtime') {
    return { ok: false, error: '需要子命令 bind-runtime 或 unbind-runtime' };
  }
  const stream = required(args, '--stream-id');
  if (!stream.ok) return stream;
  if (!STREAM_ID_RE.test(stream.value)) return { ok: false, error: `streamId 格式无效: ${stream.value}` };
  const sessionId = flagValue(args, '--session-id');
  if (operation === 'unbind-runtime') {
    return { ok: true, operation, streamId: stream.value, ...(sessionId ? { sessionId } : {}) };
  }

  const statusElement = required(args, '--status-element-id');
  if (!statusElement.ok) return statusElement;
  const imageElement = required(args, '--image-element-id');
  if (!imageElement.ok) return imageElement;
  const activeImage = required(args, '--active-image-key');
  if (!activeImage.ok) return activeImage;
  const inactiveImage = required(args, '--inactive-image-key');
  if (!inactiveImage.ok) return inactiveImage;
  if (!ELEMENT_ID_RE.test(statusElement.value)) return { ok: false, error: 'status element id 格式无效' };
  if (!ELEMENT_ID_RE.test(imageElement.value)) return { ok: false, error: 'image element id 格式无效' };
  if (!IMAGE_KEY_RE.test(activeImage.value)) return { ok: false, error: 'active image key 格式无效' };
  if (!IMAGE_KEY_RE.test(inactiveImage.value)) return { ok: false, error: 'inactive image key 格式无效' };

  let labels: Partial<Record<ScreenStatus, string>> | undefined;
  const labelsJson = flagValue(args, '--labels-json');
  if (labelsJson !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(labelsJson); } catch { return { ok: false, error: '--labels-json 必须是 JSON object' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '--labels-json 必须是 JSON object' };
    }
    const allowed = new Set<ScreenStatus>(['working', 'analyzing', 'idle', 'stalled', 'limited']);
    labels = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key as ScreenStatus) || typeof value !== 'string') {
        return { ok: false, error: `--labels-json 含无效字段: ${key}` };
      }
      labels[key as ScreenStatus] = value;
    }
  }
  return {
    ok: true,
    operation,
    streamId: stream.value,
    statusElementId: statusElement.value,
    imageElementId: imageElement.value,
    activeImageKey: activeImage.value,
    inactiveImageKey: inactiveImage.value,
    ...(labels ? { labels } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
