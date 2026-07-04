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
