import { extname } from 'node:path';

export type SendMessageFn = (
  larkAppId: string,
  chatId: string,
  content: string,
  msgType?: string,
  uuid?: string,
  hookContext?: Record<string, unknown>,
) => Promise<string>;

export type ReplyMessageFn = (
  larkAppId: string,
  messageId: string,
  content: string,
  msgType?: string,
  replyInThread?: boolean,
  uuid?: string,
  hookContext?: Record<string, unknown>,
) => Promise<string>;

export type DispatchPrimaryDeps = {
  sendMessage: SendMessageFn;
  replyMessage: ReplyMessageFn;
};

/**
 * Paths that resolve to the process's own stdin. `botmux send` reads stdin for
 * the message body (the documented `echo "msg" | botmux send` form), so passing
 * one of these to `--file`/`--image` makes a single stdin serve two consumers:
 * the body is read first, then the attachment read sees EOF. The attachment
 * upload then fails *after* the primary message was already delivered, so the
 * command exits non-zero for an already-sent message and the caller resends —
 * producing duplicate messages. Reject these up front instead.
 */
const STDIN_ALIAS_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

/** First attachment path that aliases stdin, or null if none do. */
export function findStdinAliasAttachment(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (STDIN_ALIAS_PATHS.has(p.trim())) return p;
  }
  return null;
}

export type SendFileAttachmentsDeps = {
  uploadFile: (appId: string, path: string) => Promise<string>;
  dispatch: (content: string, msgType: string) => Promise<string>;
};

export type SendFileAttachmentsResult = {
  sent: string[];                              // message ids of delivered attachments
  failed: { path: string; error: string }[];  // attachments that failed to upload/send
};

/**
 * Upload + post each file as its own message, best-effort. By the time this
 * runs the primary message has already been delivered, so a failure on one
 * attachment must NOT throw: letting it bubble would make the caller report
 * total failure (exit 1) for an already-sent message, which drives resends and
 * duplicates. Collect failures so the caller can surface them as a warning
 * while still reporting the primary send as the success it was.
 */
export async function sendFileAttachments(
  deps: SendFileAttachmentsDeps,
  appId: string,
  files: readonly string[],
): Promise<SendFileAttachmentsResult> {
  const sent: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const fp of files) {
    try {
      const fileKey = await deps.uploadFile(appId, fp);
      sent.push(await deps.dispatch(JSON.stringify({ file_key: fileKey }), 'file'));
    } catch (err: any) {
      failed.push({ path: fp, error: err?.message ?? String(err) });
    }
  }
  return { sent, failed };
}

const VIDEO_EXTENSIONS = new Set(['.mp4']);
const VIDEO_COVER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * Decide whether a send is a "pure video" send — one delivered as a standalone
 * Lark media message with no text/card primary.
 *
 * A media message CANNOT embed an `<at>`, so a send that also carries mentions
 * must NOT be pure-video: it has to go through the card path (which renders the
 * @ on the footer) and send the video as a follow-up attachment. Otherwise the
 * mention silently never fires while the success output still reports it.
 */
export function shouldSendAsPureVideo(input: {
  hasBodyText: boolean;
  imageCount: number;
  fileCount: number;
  videoCount: number;
  mentionCount: number;
}): boolean {
  return !input.hasBodyText
    && input.imageCount === 0
    && input.fileCount === 0
    && input.videoCount > 0
    && input.mentionCount === 0;
}

export type VideoAttachmentInput = {
  videoPath: string;
  coverPath: string;
  durationMs: number;
};

export type VideoAttachmentValidationResult =
  | { ok: true; videos: VideoAttachmentInput[] }
  | { ok: false; error: string };

export function validateVideoAttachments(
  videos: readonly string[],
  covers: readonly string[],
): VideoAttachmentValidationResult {
  if (videos.length === 0 && covers.length > 0) {
    return { ok: false, error: '--video-covers 需要配套 --videos 使用' };
  }
  if (videos.length !== covers.length) {
    return {
      ok: false,
      error: `--videos 与 --video-covers 数量必须一致（videos=${videos.length}, covers=${covers.length}）`,
    };
  }

  const out: VideoAttachmentInput[] = [];
  for (let i = 0; i < videos.length; i++) {
    const videoPath = videos[i];
    const coverPath = covers[i];
    const videoExt = extname(videoPath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(videoExt)) {
      return { ok: false, error: `不支持的视频格式: ${videoPath}（目前仅支持 .mp4）` };
    }
    const coverExt = extname(coverPath).toLowerCase();
    if (!VIDEO_COVER_EXTENSIONS.has(coverExt)) {
      return {
        ok: false,
        error: `不支持的视频封面格式: ${coverPath}（支持 .png/.jpg/.jpeg/.gif/.webp/.bmp）`,
      };
    }
    out.push({ videoPath, coverPath, durationMs: 0 });
  }
  return { ok: true, videos: out };
}

export type NormalizedInteractiveCardResult =
  | { ok: true; card: Record<string, unknown>; cardJson: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err: any) {
    return { ok: false, error: `${label} 不是合法 JSON: ${err?.message ?? String(err)}` };
  }
}

function cardObjectFromValue(value: unknown, label: string): { ok: true; card: Record<string, unknown> } | { ok: false; error: string } {
  let card = value;
  if (typeof card === 'string') {
    const parsed = parseJson(card, label);
    if (!parsed.ok) return parsed;
    card = parsed.value;
  }
  if (!isRecord(card)) {
    return { ok: false, error: `${label} 必须是 JSON object` };
  }
  return { ok: true, card };
}

// Interactive INPUT controls that fire a card.action.trigger callback on use.
// Custom cards are display-only, so these are rejected by tag even when they
// carry no `value` payload (selecting/picking still fires a callback). `button`
// is NOT here — it's special-cased below (open_url buttons are legit jumps).
// `checker` is Feishu's documented no-callback-by-default exception; a checker
// that opts into a callback is still caught by its `type:'callback'` behavior.
const CALLBACK_CONTROL_TAGS = new Set([
  'select_static', 'multi_select_static',
  'select_person', 'multi_select_person',
  'select_img', 'multi_select_img',
  'overflow', 'input',
  'date_picker', 'picker_time', 'picker_datetime',
]);

// A button is display/jump ONLY when it opens a URL: v2 `behaviors` carrying an
// `open_url`, or v1 non-empty `url`/`multi_url`. Everything else (a plain button,
// or one carrying an own `value` callback payload) round-trips a callback.
function isOpenUrlButton(el: Record<string, unknown>): boolean {
  if (typeof el.url === 'string' && el.url.trim() !== '') return true;
  if (el.multi_url !== undefined && el.multi_url !== null) return true;
  return Array.isArray(el.behaviors)
    && el.behaviors.some(b => isRecord(b) && b.type === 'open_url');
}

// Find any element that would produce a Lark card.action.trigger callback.
// Custom cards are display + open_url only, so ALL callback-capable controls
// are rejected — not just the ones whose payload hits a botmux privileged
// dispatch. Returns the offending JSON path, or null if the card is clean.
function findDisallowedCardCallback(value: unknown, path = 'card'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDisallowedCardCallback(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  // v2 `behaviors:[{type:'callback'}]` fires a server-side card.action.trigger
  // callback. open_url behaviors are display/jump only and stay allowed.
  if (value.type === 'callback') return `${path}.type`;
  // Form submit/reset buttons ALSO fire card.action.trigger (delivering
  // form_value to the handler). Feishu marks them with real schema fields —
  // v2 `form_action_type:'submit'|'reset'`, v1 `action_type:'form_submit'|
  // 'form_reset'` (see settings-card.ts / card-builder.ts) — NOT a
  // `type:'form_action'`. Reject those so a custom card stays display-only.
  if (typeof value.form_action_type === 'string') return `${path}.form_action_type`;
  if (value.action_type === 'form_submit' || value.action_type === 'form_reset') {
    return `${path}.action_type`;
  }
  if (typeof value.tag === 'string') {
    // Interactive input controls (dropdowns/pickers/inputs/image-select) — reject
    // by tag even without a `value` payload; interacting still fires a callback.
    if (CALLBACK_CONTROL_TAGS.has(value.tag)) return `${path}.tag(${value.tag})`;
    // A button is allowed only as an open_url jump with NO own `value` payload.
    // `value` may be a plain string OR object (both round-trip a callback), so
    // reject on presence, not shape. A plain button (no open_url) also fires a
    // callback — reject. NOTE: only card ELEMENTS (nodes with a `tag`) are judged
    // this way, so free-form chart_spec data like `{tag:'x', value:{…}}` isn't
    // misread as a control.
    if (value.tag === 'button') {
      if ('value' in value && value.value !== undefined) return `${path}.value`;
      if (!isOpenUrlButton(value)) return `${path}.tag(button)`;
    }
  }
  // Belt: reserved botmux routing discriminators anywhere (defence in depth —
  // e.g. a value round-tripped inside a behavior, or a tag we didn't enumerate).
  if (isRecord(value.value)) {
    for (const field of ['action', 'key', 'root_id'] as const) {
      if (typeof value.value[field] === 'string') return `${path}.value.${field}`;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const found = findDisallowedCardCallback(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * Normalize user-supplied Lark/Feishu interactive card JSON into the raw card
 * body expected by the Lark send/reply APIs. Accepts either:
 *   - direct card JSON: {"schema":"2.0", ...}
 *   - webhook/openapi-style wrapper: {"msg_type":"interactive","card":{...}}
 *   - wrapper with string/object content: {"msg_type":"interactive","content":"{...}"}
 *
 * Deliberately rejects callback actions. botmux owns a broad card-action
 * namespace (close/restart/ask/relay/dashboard/etc.); arbitrary callbacks from
 * a CLI-created card would be routed through those handlers with host-side
 * privileges after a user clicks. Display cards and open-url buttons still work.
 */
export function normalizeInteractiveCardInput(raw: string): NormalizedInteractiveCardResult {
  if (!raw.trim()) return { ok: false, error: '自定义卡片 JSON 不能为空' };

  const parsed = parseJson(raw, '自定义卡片 JSON');
  if (!parsed.ok) return parsed;

  let cardSource = parsed.value;
  if (isRecord(parsed.value)) {
    const msgType = typeof parsed.value.msg_type === 'string'
      ? parsed.value.msg_type
      : typeof parsed.value.msgType === 'string'
        ? parsed.value.msgType
        : undefined;
    if (msgType !== undefined) {
      if (msgType !== 'interactive') {
        return { ok: false, error: `自定义卡片 wrapper 的 msg_type 必须是 interactive（当前: ${msgType}）` };
      }
      if ('card' in parsed.value) cardSource = parsed.value.card;
      else if ('content' in parsed.value) cardSource = parsed.value.content;
      else return { ok: false, error: 'interactive wrapper 必须包含 card 或 content 字段' };
    }
  }

  const normalized = cardObjectFromValue(cardSource, '自定义卡片');
  if (!normalized.ok) return normalized;

  const callbackPath = findDisallowedCardCallback(normalized.card);
  if (callbackPath) {
    return {
      ok: false,
      error: `自定义卡片暂不允许 callback 行为（${callbackPath}），请改用 open_url 等展示/跳转能力`,
    };
  }

  return { ok: true, card: normalized.card, cardJson: JSON.stringify(normalized.card) };
}

export type SendVideoAttachmentsDeps = {
  uploadFile: (appId: string, path: string) => Promise<string>;
  uploadImage: (appId: string, path: string) => Promise<string>;
  dispatch: (content: string, msgType: string) => Promise<string>;
  // Optional: dispatch used for the FIRST successfully-sent video only. A
  // pure-video send (no text/card primary) has no other message to carry the
  // quote/reply chain, so its first media message must go through the primary
  // dispatch (which applies the chat-scope quoteTargetId) to stay consistent
  // with card/file/image sends. Later videos remain best-effort via `dispatch`.
  // Omitted for secondary sends (card is already the primary) → all use `dispatch`.
  primaryDispatch?: (content: string, msgType: string) => Promise<string>;
};

export type SendVideoAttachmentsResult = {
  sent: string[];
  failed: { path: string; coverPath: string; error: string }[];
};

export async function sendVideoAttachments(
  deps: SendVideoAttachmentsDeps,
  appId: string,
  videos: readonly VideoAttachmentInput[],
): Promise<SendVideoAttachmentsResult> {
  const sent: string[] = [];
  const failed: { path: string; coverPath: string; error: string }[] = [];
  // The first video that actually goes out uses `primaryDispatch` (quote chain);
  // every later one uses plain `dispatch`. Tracked on success only, so if the
  // first video's upload fails the next one inherits the primary slot.
  let primaryUsed = false;
  for (const video of videos) {
    try {
      const fileKey = await deps.uploadFile(appId, video.videoPath);
      const imageKey = await deps.uploadImage(appId, video.coverPath);
      const content = JSON.stringify({
        file_key: fileKey,
        image_key: imageKey,
        duration: video.durationMs,
      });
      const send = (!primaryUsed && deps.primaryDispatch) ? deps.primaryDispatch : deps.dispatch;
      const messageId = await send(content, 'media');
      primaryUsed = true;
      sent.push(messageId);
    } catch (err: any) {
      failed.push({
        path: video.videoPath,
        coverPath: video.coverPath,
        error: err?.message ?? String(err),
      });
    }
  }
  return { sent, failed };
}

export type DispatchPrimaryOptions = {
  appId: string;
  targetChatId: string;
  quoteTargetId: string | null | undefined;
  content: string;
  msgType: string;
  hookContext: Record<string, unknown>;
  MessageWithdrawnError: new (...args: any[]) => Error;
  dispatch: (content: string, msgType: string) => Promise<string>;
  onQuoteWithdrawn?: (messageId: string) => void;
};

export type DispatchPrimaryResult = {
  messageId: string;
  primaryQuotedId: string | null;
};

export async function dispatchPrimaryMessage(
  deps: DispatchPrimaryDeps,
  opts: DispatchPrimaryOptions,
): Promise<DispatchPrimaryResult> {
  if (!opts.quoteTargetId) {
    return {
      messageId: await opts.dispatch(opts.content, opts.msgType),
      primaryQuotedId: null,
    };
  }

  try {
    const messageId = await deps.replyMessage(
      opts.appId,
      opts.quoteTargetId,
      opts.content,
      opts.msgType,
      false,
      undefined,
      opts.hookContext,
    );
    return { messageId, primaryQuotedId: opts.quoteTargetId };
  } catch (err: any) {
    if (err instanceof opts.MessageWithdrawnError) {
      opts.onQuoteWithdrawn?.(opts.quoteTargetId);
      return {
        messageId: await deps.sendMessage(
          opts.appId,
          opts.targetChatId,
          opts.content,
          opts.msgType,
          undefined,
          opts.hookContext,
        ),
        primaryQuotedId: null,
      };
    }
    throw err;
  }
}
