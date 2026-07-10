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

function findDisallowedCardCallback(value: unknown, path = 'card'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDisallowedCardCallback(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  // v2 behaviors that fire a server-side card.action.trigger callback:
  //   - `callback`    — button/select/input callbacks
  //   - `form_action` — form submit/reset (delivers form_value to the handler)
  // open_url behaviors are display/jump only and stay allowed.
  if (value.type === 'callback' || value.type === 'form_action') return `${path}.type`;
  // botmux routes card actions off the element `value` payload via SEVERAL
  // discriminators, not just `action`. A CLI-supplied card carrying ANY of them
  // reaches those host-side handlers once a user clicks/selects:
  //   - `value.action` — buttons (close/restart/land/grant/voice_summary/…)
  //   - `value.key`    — select_static dropdowns (adopt_select/adopt_resume_select/
  //                      codex_app_thread_select/repo_switch/repo_worktree)
  //   - `value.root_id`— the session anchor every dropdown/button needs to target
  //                      a session; the repo-select branch acts on a bare
  //                      `option + root_id` with NO action/key (plain repo switch
  //                      to an arbitrary path), so root_id alone must be rejected.
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
