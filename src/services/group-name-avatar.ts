/** Optional native renderer is loaded only when a name avatar is requested. */
export async function renderGroupNameAvatar(name: string): Promise<Buffer> {
  // /g's historical truncation appends an ellipsis after its 50-unit budget.
  if (!name.trim() || name.length > 51) throw new Error('Avatar name must contain 1–51 UTF-16 units');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { screenshotFontFamilies } = await import('../utils/screenshot-renderer.js');
  const canvas = createCanvas(360, 360);
  const ctx = canvas.getContext('2d');
  const background = ctx.createLinearGradient(0, 0, 360, 360);
  background.addColorStop(0, '#174b85');
  background.addColorStop(1, '#147d89');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 360, 360);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].map(s => s.segment);
  let lines: string[] = [];
  let size = 64;
  for (; size >= 18; size -= 2) {
    ctx.font = `bold ${size}px ${screenshotFontFamilies()}`;
    lines = [''];
    for (const char of graphemes) {
      const i = lines.length - 1;
      if (lines[i] && ctx.measureText(lines[i] + char).width > 280) lines.push(char);
      else lines[i] += char;
    }
    if (lines.length * size * 1.25 <= 280 && lines.every(line => ctx.measureText(line).width <= 280)) break;
  }
  if (size < 18) throw new Error('Group name cannot fit in avatar');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const height = size * 1.25;
  lines.forEach((line, i) => ctx.fillText(line, 180, 180 + (i - (lines.length - 1) / 2) * height));
  return canvas.toBuffer('image/png');
}

export async function applyGroupNameAvatar(larkAppId: string, chatId: string, name: string): Promise<void> {
  const image = await renderGroupNameAvatar(name);
  const { getBotClient } = await import('../bot-registry.js');
  const client = getBotClient(larkAppId);
  const uploaded = await client.im.v1.image.create({ data: { image_type: 'avatar', image } });
  const imageKey = (uploaded as unknown as { image_key?: string; data?: { image_key?: string } })?.image_key
    ?? (uploaded as unknown as { data?: { image_key?: string } })?.data?.image_key;
  if (!imageKey) throw new Error('Avatar upload returned no image key');
  const updated = await client.im.v1.chat.update({ path: { chat_id: chatId }, data: { avatar: imageKey } });
  if (updated?.code !== undefined && updated.code !== 0) throw new Error(`Avatar update failed: ${updated.code} ${updated.msg ?? ''}`);
}
