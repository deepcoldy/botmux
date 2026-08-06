/**
 * Session-group avatar branding (p2pMode='group').
 *
 * Zero-permission visual "tag": every session group gets a distinctive
 * built-in avatar (purple gradient + white bot bubble), so bot session groups
 * are recognizable at a glance in the chat list. This works with scopes
 * botmux already holds (im image upload + chat update, and the bot owns its
 * session groups) — no tenant tag catalog, no user OAuth, no console visit.
 *
 * The PNG ships inline (base64, ~3.4KB). It is uploaded once per bot with
 * image_type='avatar' and the resulting image_key is cached in
 * `${dataDir}/session-avatar-cache-${appId}.json`; every birth then only
 * costs one chat.update. All paths are best-effort fire-and-forget.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBot, getBotClient } from '../bot-registry.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** 512×512 purple-gradient bot-bubble PNG (see docs: session-group design). */
const AVATAR_PNG_BASE64 = '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';

interface AvatarCache {
  imageKey?: string;
}

function cachePath(appId: string): string {
  return join(config.session.dataDir, `session-avatar-cache-${appId}.json`);
}

function loadCache(appId: string): AvatarCache {
  try {
    const fp = cachePath(appId);
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, 'utf-8')) as AvatarCache;
  } catch { /* corrupted cache → start fresh */ }
  return {};
}

function saveCache(appId: string, cache: AvatarCache): void {
  try {
    const fp = cachePath(appId);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[session-avatar] cache persist failed: ${err}`);
  }
}

/** Upload the built-in avatar once per bot; cached image_key thereafter. */
async function ensureAvatarImageKey(larkAppId: string): Promise<string | null> {
  const cache = loadCache(larkAppId);
  if (cache.imageKey) return cache.imageKey;
  try {
    const client: any = getBotClient(larkAppId);
    // SDK returns { image_key } directly (not wrapped in { code, data }) —
    // same contract as client.ts uploadImage, but with image_type 'avatar'.
    const res = await client.im.v1.image.create({
      data: { image_type: 'avatar', image: Buffer.from(AVATAR_PNG_BASE64, 'base64') },
    });
    const imageKey = res?.image_key;
    if (!imageKey) throw new Error(`no image_key in response (${JSON.stringify(res)})`);
    cache.imageKey = imageKey;
    saveCache(larkAppId, cache);
    logger.info(`[session-avatar] uploaded avatar for ${larkAppId} → ${imageKey}`);
    return imageKey;
  } catch (err) {
    logger.warn(`[session-avatar] avatar upload failed: ${err}`);
    return null;
  }
}

/**
 * Apply the session-group avatar to a freshly-born group. Fire-and-forget —
 * never throws; a failure just leaves the default Feishu group avatar.
 */
export async function applySessionGroupAvatar(larkAppId: string, chatId: string): Promise<void> {
  try {
    const cfg = getBot(larkAppId).config;
    if (cfg.sessionGroup?.avatar === 'off') return;
    const imageKey = await ensureAvatarImageKey(larkAppId);
    if (!imageKey) return;
    const client: any = getBotClient(larkAppId);
    const res = await client.im.v1.chat.update({
      path: { chat_id: chatId },
      data: { avatar: imageKey },
    });
    if (res?.code !== 0 && res?.code !== undefined) {
      logger.warn(`[session-avatar] chat.update avatar failed for ${chatId.substring(0, 12)}: ${res?.msg} (code ${res?.code})`);
      return;
    }
    logger.info(`[session-avatar] applied to ${chatId.substring(0, 12)}`);
  } catch (err) {
    logger.warn(`[session-avatar] applying to ${chatId.substring(0, 12)} threw: ${err}`);
  }
}
