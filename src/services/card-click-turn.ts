/**
 * Signed, single-use card button that names a fixed prompt and a chat or session.
 *
 * The daemon HMAC-signs the canonical payload. A click is accepted only when the
 * signature matches, the token is unexpired, and its nonce has not been used.
 * Nothing in this module reads the session owner or creator — callers pass the
 * clicker's own open_id into {@link admitCardClickSender}.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { callbackButton, simpleCard } from '../im/lark/card-primitives.js';

export const CARD_CLICK_TURN_ACTION = 'card_click_turn';
const SIGNING_DOMAIN = 'botmux-card-click-turn-v1:';
const CLAIMS_VERSION = 1;

export const CARD_CLICK_TURN_DEFAULT_TTL_MS = 60 * 60 * 1000;
export const CARD_CLICK_TURN_MIN_TTL_MS = 60 * 1000;
export const CARD_CLICK_TURN_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CARD_CLICK_TURN_MAX_PROMPT_CHARS = 1500;
export const CARD_CLICK_TURN_MAX_WORKING_DIR_CHARS = 1024;

const CHAT_ID_RE = /^oc_[A-Za-z0-9]+$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,80}$/;
const APP_ID_RE = /^[A-Za-z0-9_]{4,64}$/;

export type CardClickChatType = 'group' | 'p2p';

export interface CardClickTurnClaims {
  v: 1;
  larkAppId: string;
  prompt: string;
  chatId?: string;
  sessionId?: string;
  workingDir?: string;
  chatType?: CardClickChatType;
  nonce: string;
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

export type CardClickAdmitReason =
  | 'no_identity'
  | 'bot_or_app'
  | 'blocked'
  | 'not_allowed'
  | 'cannot_operate'
  | 'grant_blocked';

export function admitCardClickSender(input: {
  openId?: string;
  isBotOrApp: boolean;
  talk: { allowed: boolean; reason?: string };
  canOperate: boolean;
  grantBlocked: boolean;
}): { ok: true; senderOpenId: string } | { ok: false; reason: CardClickAdmitReason } {
  if (!input.openId) return { ok: false, reason: 'no_identity' };
  if (input.isBotOrApp) return { ok: false, reason: 'bot_or_app' };
  if (!input.talk.allowed && input.talk.reason === 'blocked') return { ok: false, reason: 'blocked' };
  if (!input.talk.allowed) return { ok: false, reason: 'not_allowed' };
  if (input.grantBlocked) return { ok: false, reason: 'grant_blocked' };
  if (!input.canOperate) return { ok: false, reason: 'cannot_operate' };
  return { ok: true, senderOpenId: input.openId };
}

export function canonicalCardClickTurnPayload(claims: CardClickTurnClaims): string {
  return JSON.stringify([
    claims.v,
    claims.larkAppId,
    claims.prompt,
    claims.chatId ?? '',
    claims.sessionId ?? '',
    claims.workingDir ?? '',
    claims.chatType ?? '',
    claims.nonce,
    claims.exp,
  ]);
}

export function signCardClickTurnPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(SIGNING_DOMAIN + payload, 'utf8').digest('base64url');
}

function signaturesMatch(provided: string, expected: string): boolean {
  const got = Buffer.from(provided);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function isAbsoluteNormalizedDir(dir: string): boolean {
  if (!dir.startsWith('/') || dir.includes('\0') || dir.includes('\n')) return false;
  if (dir.length > CARD_CLICK_TURN_MAX_WORKING_DIR_CHARS) return false;
  // Reject `..`, trailing slashes, and other non-canonical forms. The signed
  // string is compared again at click time, so the path must already be stable.
  const normalized = dir.replace(/\/+/g, '/');
  if (normalized !== dir) return false;
  const parts = dir.split('/');
  return parts.every(part => part !== '..' && part !== '.');
}

export function issueCardClickTurn(input: {
  secret: string;
  larkAppId: string;
  prompt: string;
  chatId?: string;
  sessionId?: string;
  workingDir?: string;
  chatType?: CardClickChatType;
  ttlMs?: number;
  now?: number;
  nonce?: string;
}): { ok: true; claims: CardClickTurnClaims; payload: string; sig: string }
  | { ok: false; error: string } {
  if (!input.secret) return { ok: false, error: 'missing_secret' };
  if (!APP_ID_RE.test(input.larkAppId)) return { ok: false, error: 'invalid_app' };
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > CARD_CLICK_TURN_MAX_PROMPT_CHARS) return { ok: false, error: 'invalid_prompt' };
  const chatId = input.chatId?.trim() ?? '';
  const sessionId = input.sessionId?.trim() ?? '';
  if (!!chatId === !!sessionId) return { ok: false, error: 'target_required' };
  if (chatId && !CHAT_ID_RE.test(chatId)) return { ok: false, error: 'invalid_chat' };
  if (sessionId && !SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'invalid_session' };
  const workingDir = input.workingDir?.trim() ?? '';
  if (workingDir && !isAbsoluteNormalizedDir(workingDir)) return { ok: false, error: 'invalid_working_dir' };
  if (input.chatType && input.chatType !== 'group' && input.chatType !== 'p2p') {
    return { ok: false, error: 'invalid_chat_type' };
  }
  const ttlMs = input.ttlMs ?? CARD_CLICK_TURN_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < CARD_CLICK_TURN_MIN_TTL_MS || ttlMs > CARD_CLICK_TURN_MAX_TTL_MS) {
    return { ok: false, error: 'invalid_ttl' };
  }
  const now = input.now ?? Date.now();
  const nonce = input.nonce ?? randomUUID();
  if (!NONCE_RE.test(nonce)) return { ok: false, error: 'invalid_nonce' };
  const claims: CardClickTurnClaims = {
    v: CLAIMS_VERSION,
    larkAppId: input.larkAppId,
    prompt,
    ...(chatId ? { chatId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(input.chatType ? { chatType: input.chatType } : {}),
    nonce,
    exp: now + ttlMs,
  };
  const payload = canonicalCardClickTurnPayload(claims);
  return { ok: true, claims, payload, sig: signCardClickTurnPayload(payload, input.secret) };
}

export function readCardClickTurnClaims(
  payload: string,
  sig: string,
  secret: string,
  now: number,
): { ok: true; claims: CardClickTurnClaims } | { ok: false; reason: 'bad_signature' | 'expired' } {
  if (!payload || !sig || !secret) return { ok: false, reason: 'bad_signature' };
  const expected = signCardClickTurnPayload(payload, secret);
  if (!signaturesMatch(sig, expected)) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return { ok: false, reason: 'bad_signature' }; }
  if (!Array.isArray(parsed) || parsed.length !== 9) return { ok: false, reason: 'bad_signature' };
  const [v, larkAppId, prompt, chatId, sessionId, workingDir, chatType, nonce, exp] = parsed;
  if (v !== CLAIMS_VERSION || typeof larkAppId !== 'string' || typeof prompt !== 'string'
    || typeof chatId !== 'string' || typeof sessionId !== 'string' || typeof workingDir !== 'string'
    || typeof chatType !== 'string' || typeof nonce !== 'string' || typeof exp !== 'number') {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!APP_ID_RE.test(larkAppId) || !prompt || prompt.length > CARD_CLICK_TURN_MAX_PROMPT_CHARS
    || !NONCE_RE.test(nonce) || !Number.isSafeInteger(exp)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!!chatId === !!sessionId) return { ok: false, reason: 'bad_signature' };
  if (chatId && !CHAT_ID_RE.test(chatId)) return { ok: false, reason: 'bad_signature' };
  if (sessionId && !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: 'bad_signature' };
  if (workingDir && !isAbsoluteNormalizedDir(workingDir)) return { ok: false, reason: 'bad_signature' };
  if (chatType !== '' && chatType !== 'group' && chatType !== 'p2p') return { ok: false, reason: 'bad_signature' };
  const claims: CardClickTurnClaims = {
    v: CLAIMS_VERSION,
    larkAppId,
    prompt,
    ...(chatId ? { chatId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(chatType === 'group' || chatType === 'p2p' ? { chatType } : {}),
    nonce,
    exp,
  };
  if (canonicalCardClickTurnPayload(claims) !== payload) return { ok: false, reason: 'bad_signature' };
  if (now >= exp) return { ok: false, reason: 'expired' };
  if (exp - now > CARD_CLICK_TURN_MAX_TTL_MS) return { ok: false, reason: 'bad_signature' };
  return { ok: true, claims };
}

export interface CardClickNonceConsume {
  consume(nonce: string, exp: number, now: number): 'ok' | 'replayed' | 'expired';
}

/** Persistent single-use nonce file. Expired entries are dropped; a used nonce
 * stays until its own expiry so a restart cannot replay an unexpired token. */
export class CardClickNonceStore implements CardClickNonceConsume {
  private used = new Map<string, number>();

  private constructor(private readonly filePath: string | undefined) {}

  static open(filePath?: string): CardClickNonceStore {
    const store = new CardClickNonceStore(filePath);
    if (filePath) store.load();
    return store;
  }

  consume(nonce: string, exp: number, now: number): 'ok' | 'replayed' | 'expired' {
    return this.withLock(() => {
      // Disk is the fleet record. Reload under the lock so another daemon's
      // consume is not overwritten by this process's stale memory.
      this.reload();
      this.prune(now);
      if (now >= exp) return 'expired';
      if (this.used.has(nonce)) return 'replayed';
      this.used.set(nonce, exp);
      try {
        this.persist();
      } catch (err) {
        this.used.delete(nonce);
        throw err;
      }
      return 'ok';
    });
  }

  private withLock<T>(fn: () => T): T {
    const filePath = this.filePath;
    if (!filePath) return fn();
    const lockPath = `${filePath}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 2_000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
        } catch { /* the owner released it, or we lost the race */ }
        if (Date.now() > deadline) throw new Error('card click nonce lock timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* already released */ }
    }
  }

  private prune(now: number): void {
    for (const [nonce, exp] of this.used) {
      if (exp <= now) this.used.delete(nonce);
    }
  }

  private load(): void {
    this.reload();
  }

  private reload(): void {
    const filePath = this.filePath;
    // No file: this process is the only record. Wiping it would forget a nonce
    // that was consumed a moment ago.
    if (!filePath) return;
    const fresh = new Map<string, number>();
    let info;
    try { info = lstatSync(filePath); } catch {
      this.used = fresh;
      return;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('card click nonce store is not a regular file');
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { nonces?: Record<string, number> };
    const nonces = parsed?.nonces;
    if (!nonces || typeof nonces !== 'object') throw new Error('card click nonce store is unreadable');
    const now = Date.now();
    for (const [nonce, exp] of Object.entries(nonces)) {
      if (NONCE_RE.test(nonce) && Number.isSafeInteger(exp) && exp > now) fresh.set(nonce, exp);
    }
    this.used = fresh;
  }

  private persist(): void {
    const filePath = this.filePath;
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ nonces: Object.fromEntries(this.used) });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, filePath);
  }
}

export function buildCardClickTurnCard(input: {
  title: string;
  prompt: string;
  buttonLabel: string;
  payload: string;
  sig: string;
}): Record<string, unknown> {
  return simpleCard({
    title: input.title,
    template: 'blue',
    div: input.prompt,
    buttons: [
      callbackButton(input.buttonLabel, 'primary', {
        action: CARD_CLICK_TURN_ACTION,
        payload: input.payload,
        sig: input.sig,
      }),
    ],
  });
}

export function parseCardClickTurnPost(body: unknown): {
  ok: true;
  larkAppId?: string;
  prompt: string;
  chatId?: string;
  sessionId?: string;
  postChatId: string;
  workingDir?: string;
  chatType?: CardClickChatType;
  ttlMs?: number;
  buttonLabel?: string;
  title?: string;
} | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad_request' };
  const raw = body as Record<string, unknown>;
  if (typeof raw.prompt !== 'string') return { ok: false, error: 'invalid_prompt' };
  const chatId = typeof raw.chatId === 'string' ? raw.chatId.trim() : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!!chatId === !!sessionId) return { ok: false, error: 'target_required' };
  const postChatId = typeof raw.postChatId === 'string' && raw.postChatId.trim()
    ? raw.postChatId.trim()
    : chatId;
  if (!postChatId || !CHAT_ID_RE.test(postChatId)) return { ok: false, error: 'invalid_post_chat' };
  let chatType: CardClickChatType | undefined;
  if (raw.chatType !== undefined) {
    if (raw.chatType !== 'group' && raw.chatType !== 'p2p') return { ok: false, error: 'invalid_chat_type' };
    chatType = raw.chatType;
  }
  let ttlMs: number | undefined;
  if (raw.ttlMs !== undefined) {
    if (typeof raw.ttlMs !== 'number') return { ok: false, error: 'invalid_ttl' };
    ttlMs = raw.ttlMs;
  }
  let buttonLabel: string | undefined;
  if (raw.buttonLabel !== undefined) {
    if (typeof raw.buttonLabel !== 'string' || !raw.buttonLabel.trim() || raw.buttonLabel.trim().length > 40) {
      return { ok: false, error: 'invalid_button_label' };
    }
    buttonLabel = raw.buttonLabel.trim();
  }
  let title: string | undefined;
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.trim().length > 80) {
      return { ok: false, error: 'invalid_title' };
    }
    title = raw.title.trim();
  }
  const workingDir = typeof raw.workingDir === 'string' ? raw.workingDir.trim() : undefined;
  return {
    ok: true,
    prompt: raw.prompt,
    ...(chatId ? { chatId } : {}),
    ...(sessionId ? { sessionId } : {}),
    postChatId,
    ...(workingDir ? { workingDir } : {}),
    ...(chatType ? { chatType } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(buttonLabel ? { buttonLabel } : {}),
    ...(title ? { title } : {}),
  };
}
