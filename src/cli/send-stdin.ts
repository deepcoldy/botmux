import { fstatSync, type Stats } from 'node:fs';
import { isatty } from 'node:tty';

/** How `botmux send` may treat fd 0 as a message body.
 *
 *  - `tty`: an interactive terminal. Never a body (waiting would look frozen).
 *  - `not-piped`: /dev/null, a closed fd reopened on /dev/null, or any other
 *    non-terminal device. Nothing was piped in; reading can only yield EOF
 *    (or, for devices like /dev/zero, never end).
 *  - `file`: a regular file. zsh (and bash for large documents) hands a
 *    heredoc over this way; `< file` too. Always finite.
 *  - `stream`: a pipe or socket. A heredoc in bash >= 5.1, `echo … |`, a slow
 *    producer, or a parent process that inherited stdin and never closes it
 *    (Claude Code's Bash tool does not wire a command containing a heredoc to
 *    /dev/null). Indistinguishable by fd type alone. */
export type SendStdinShape = 'tty' | 'not-piped' | 'file' | 'stream';

export interface StdinFdProbe {
  isatty(): boolean;
  fstat(): Pick<Stats, 'isFile' | 'isFIFO' | 'isSocket'>;
}

const realFd0: StdinFdProbe = {
  isatty: () => isatty(0),
  fstat: () => fstatSync(0),
};

export function classifySendStdin(fd: StdinFdProbe = realFd0): SendStdinShape {
  try {
    if (fd.isatty()) return 'tty';
  } catch { /* fall through to fstat */ }
  let stat: ReturnType<StdinFdProbe['fstat']>;
  try {
    stat = fd.fstat();
  } catch {
    // Unknown shape: keep the historical behaviour of a piped stdin rather
    // than silently dropping a body we could not classify.
    return 'stream';
  }
  if (stat.isFile()) return 'file';
  if (stat.isFIFO() || stat.isSocket()) return 'stream';
  return 'not-piped';
}

/** - `skip`: do not touch stdin; there is no body on it.
 *  - `read-to-eof`: stdin is the body source; wait for EOF however long the
 *    writer takes (`slow | botmux send` keeps working).
 *  - `probe`: the send already carries a payload (attachments), so stdin is
 *    only an optional body. Take it if it is already flowing; if nothing
 *    arrives within the probe window, stop listening instead of blocking on an
 *    EOF that may never come. */
export type SendStdinPolicy = 'skip' | 'read-to-eof' | 'probe';

export function sendStdinPolicy(
  shape: SendStdinShape,
  opts: { explicitDash: boolean; hasAttachments: boolean },
): SendStdinPolicy {
  if (shape === 'tty' || shape === 'not-piped') return 'skip';
  // A lone `-` explicitly names stdin as the body; a regular file always ends.
  if (shape === 'file' || opts.explicitDash || !opts.hasAttachments) return 'read-to-eof';
  return 'probe';
}

/** How long an attachment send waits for a piped body to start flowing.
 *  A heredoc or `echo … |` has its bytes (and usually EOF) in the pipe before
 *  this process finishes starting up; only a producer that stays silent this
 *  long after start-up is treated as "no body". */
export const SEND_STDIN_PROBE_MS = 1_000;

export type SendStdinOutcome = 'skipped' | 'eof' | 'no-input';

export interface SendStdinRead {
  bytes: Buffer;
  outcome: SendStdinOutcome;
}

/** Read the `botmux send` body under `policy`.
 *
 *  `probe` resolves `no-input` when neither data nor EOF shows up within
 *  `probeMs`; it then detaches and pauses the stream so an open stdin can no
 *  longer keep the process alive. Once the first byte has arrived the writer is
 *  actively producing, so the read continues to EOF exactly like
 *  `read-to-eof`. A read error yields an empty body, as the previous reader
 *  did (an unreadable stdin has always meant "no body", never a crash).
 *  `skip` never touches the stream. */
export function readSendStdin(
  policy: SendStdinPolicy,
  opts: { stream?: () => NodeJS.ReadableStream; probeMs?: number } = {},
): Promise<SendStdinRead> {
  if (policy === 'skip') return Promise.resolve({ bytes: Buffer.alloc(0), outcome: 'skipped' });
  const stream = (opts.stream ?? (() => process.stdin))();
  const probeMs = opts.probeMs ?? SEND_STDIN_PROBE_MS;
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (outcome: SendStdinOutcome) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      // onError stays attached: a later error on an abandoned stdin must not
      // surface as an uncaught exception.
      if (outcome === 'no-input') stream.pause();
      resolve({ bytes: Buffer.concat(chunks), outcome });
    };
    const onData = (chunk: Buffer | string) => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = () => finish('eof');
    const onError = () => {
      if (!done) chunks.length = 0;
      finish('eof');
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    if (policy === 'probe') {
      timer = setTimeout(() => { if (chunks.length === 0) finish('no-input'); }, probeMs);
    }
  });
}

/** Why a stdin-sourced body came out empty, for refusal messages. */
export function describeEmptySendStdin(
  shape: SendStdinShape,
  outcome: SendStdinOutcome,
  probeMs: number = SEND_STDIN_PROBE_MS,
): string {
  if (shape === 'tty') return 'stdin 是终端，没有管道输入';
  if (outcome === 'skipped') return 'stdin 不是管道输入（例如 /dev/null）';
  if (outcome === 'no-input') return `stdin 在 ${probeMs / 1000} 秒内没有数据`;
  return 'stdin 没有内容';
}
