import type { LarkAttachment, LarkMessage } from '../../types.js';
import { extractResources } from './message-parser.js';

type Node = { tag: string; text?: string; href?: string; image_key?: string; style?: string[] };
type Row = Node[];

/** Only copy display elements: never replay mentions or executable card controls. */
function taskRows(raw: string | undefined): Row[] | undefined {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const body = Array.isArray(parsed.content) ? parsed
      : Object.values(parsed).find((v: any) => Array.isArray(v?.content)) as any;
    if (!body) return;
    const rows = [...(body.title ? [[{ tag: 'text', text: body.title }]] : []), ...body.content];
    let foundCommand = false;
    const result: Row[] = [];
    for (const row of rows) {
      const output: Row = [];
      for (const node of Array.isArray(row) ? row : [row]) {
        if (!foundCommand) {
          if (node.tag === 'at' || (node.tag === 'text' && !node.text?.trim())) continue;
          if (node.tag !== 'text' || !/^\s*\/fork(?:\s|$)/i.test(node.text ?? '')) return;
          foundCommand = true;
          const text = node.text.replace(/^\s*\/fork\s*/i, '');
          if (text) output.push({ tag: 'text', text });
        } else if (node.tag === 'text' && typeof node.text === 'string') {
          output.push({ tag: 'text', text: node.text,
            ...(Array.isArray(node.style) ? { style: node.style.filter((s: string) => ['bold', 'italic', 'underline', 'lineThrough'].includes(s)) } : {}) });
        } else if (node.tag === 'a' && typeof node.href === 'string' && /^https?:\/\//i.test(node.href)) {
          output.push({ tag: 'a', text: node.text || node.href, href: node.href });
        } else if (node.tag === 'img' && typeof node.image_key === 'string') {
          output.push({ tag: 'img', image_key: node.image_key });
        } else if (node.tag === 'at') {
          output.push({ tag: 'text', text: `@${node.user_name || node.user_id || ''}` });
        } else {
          // Unsupported post elements must not silently disappear.
          return;
        }
      }
      if (output.length) result.push(output);
    }
    return foundCommand ? result : undefined;
  } catch { return; }
}

export async function prepareForkTopic(
  taskText: string,
  message: LarkMessage,
  deps: {
    download: (resources: ReturnType<typeof extractResources>) => Promise<{ attachments: LarkAttachment[] }>;
    upload: (path: string) => Promise<string>;
    imageUnavailable: string;
    fallbackTitle: string;
  },
): Promise<{ title: string; content: Row[]; attachments: LarkAttachment[] }> {
  const resources = message.rawPostContent ? extractResources('post', message.rawPostContent) : [];
  const attachments = message.attachments ?? (resources.length ? (await deps.download(resources)).attachments : []);
  const images = new Map<string, string>();
  for (const resource of resources.filter(r => r.type === 'image')) {
    const attachment = attachments.find(a => a.type === 'image' && a.name === resource.name);
    if (!attachment) continue;
    try { images.set(resource.key, await deps.upload(attachment.path)); } catch { /* source link remains available */ }
  }

  const richRows = taskRows(message.rawPostContent);
  let content: Row[];
  if (richRows) {
    content = richRows.map(row => row.map(node => node.tag !== 'img' ? node
      : images.has(node.image_key!) ? { tag: 'img', image_key: images.get(node.image_key!)! }
        : { tag: 'text', text: deps.imageUnavailable }));
  } else {
    // Preserve the complete task, including newlines, when rich input is absent
    // or unrecognised. Never truncate instructions to fit a topic title.
    // Re-uploaded images are appended as real img nodes below, so drop their
    // `[图片 N]` text placeholders (matched by the image ordinal, independent of
    // the file counter) or the same picture is shown twice. Failed
    // downloads/uploads keep the placeholder and get no node; file placeholders
    // stay as text because only images are rendered as nodes.
    let fallbackText = taskText;
    const uploadedImageKeys: string[] = [];
    let imageOrdinal = 0;
    for (const resource of resources.filter(r => r.type === 'image')) {
      imageOrdinal += 1;
      const uploadedKey = images.get(resource.key);
      if (!uploadedKey) continue;
      uploadedImageKeys.push(uploadedKey);
      // Global replacement: a duplicated in-body image shares one key and one
      // ordinal, so every occurrence of its placeholder goes with that node.
      // The trailing boundary keeps ordinal 1 from matching `[图片 12]`;
      // an optional `: alt` suffix is tolerated.
      const placeholder = new RegExp(`\\[图片\\s*${imageOrdinal}\\s*(?::[^\\]]*)?\\]`, 'g');
      fallbackText = fallbackText.replace(placeholder, '');
    }
    content = fallbackText.split(/\r?\n/).map(text => [{ tag: 'text', text: text || ' ' }]);
    for (const imageKey of uploadedImageKeys) content.push([{ tag: 'img', image_key: imageKey }]);
  }
  const summary = (richRows ?? content).map(row => row.filter(n => n.tag === 'text' || n.tag === 'a')
    .map(n => n.text ?? '').join(' ').replace(/https?:\/\/\S+/gi, '')
    .replace(/\[(?:图片|文件)\s*\d+[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()).find(Boolean);
  const chars = Array.from(summary || deps.fallbackTitle);
  const title = chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('');
  return { title, content, attachments };
}
