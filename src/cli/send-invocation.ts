import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isRiffUploadPlaceholder,
  parseRiffUploadIndex,
} from '../services/riff-upload-placeholder.js';

/** `botmux send` argument contract.
 *
 * The parser is role-agnostic: it only tokenizes flags/positionals and records
 * deterministic arity errors. The client and Riff-host validators then apply
 * their own policies (client rejects hand-written Riff placeholders and runs
 * the positional-file heuristic; the host accepts placeholders but checks their
 * bijection against the upload manifest and never stats anything). */

export type SendFlagKind = 'bool' | 'value' | 'optional';

export interface SendFlagSpec {
  names: readonly string[];
  kind: SendFlagKind;
}

/** Single source of truth for every flag production callers construct.
 *  `--version` is deliberately absent: `botmux --version` is the global form,
 *  while `botmux send --version` is an unknown send flag. */
export const SEND_FLAG_SPECS: readonly SendFlagSpec[] = [
  { names: ['--help', '-h'], kind: 'bool' },
  { names: ['--dry-run'], kind: 'bool' },
  { names: ['--card', '--text'], kind: 'bool' },
  { names: ['--top-level'], kind: 'bool' },
  { names: ['--no-quote'], kind: 'bool' },
  { names: ['--mention-back'], kind: 'bool' },
  { names: ['--no-mention'], kind: 'bool' },
  { names: ['--voice'], kind: 'bool' },
  { names: ['--slash'], kind: 'bool' },
  { names: ['--remote-runner-outbound'], kind: 'bool' },
  { names: ['--schedule-remove-self'], kind: 'bool' },
  { names: ['--anyway'], kind: 'bool' },
  { names: ['--attention'], kind: 'optional' },
  { names: ['--urgent'], kind: 'optional' },
  { names: ['--content-file'], kind: 'value' },
  { names: ['--card-file'], kind: 'value' },
  { names: ['--card-json'], kind: 'value' },
  { names: ['--diff'], kind: 'value' },
  { names: ['--image', '--images'], kind: 'value' },
  { names: ['--file', '--files'], kind: 'value' },
  { names: ['--video', '--videos'], kind: 'value' },
  { names: ['--video-cover', '--video-covers'], kind: 'value' },
  { names: ['--mention'], kind: 'value' },
  { names: ['--expected-link'], kind: 'value' },
  { names: ['--layout'], kind: 'value' },
  { names: ['--response-kind'], kind: 'value' },
  { names: ['--image-mode'], kind: 'value' },
  { names: ['--chat-id'], kind: 'value' },
  { names: ['--into'], kind: 'value' },
  { names: ['--quote'], kind: 'value' },
  { names: ['--as'], kind: 'value' },
  { names: ['--plugin-card-action'], kind: 'value' },
  { names: ['--completion-proposal-file'], kind: 'value' },
  { names: ['--session-id'], kind: 'value' },
];

const KNOWN_FLAGS = new Map<string, SendFlagSpec>();
for (const spec of SEND_FLAG_SPECS) {
  for (const name of spec.names) KNOWN_FLAGS.set(name, spec);
}

export const SEND_FILE_FLAGS: Record<string, true> = {
  '--image': true, '--images': true,
  '--file': true, '--files': true,
  '--video': true, '--videos': true,
  '--video-cover': true, '--video-covers': true,
};

/** Upload-bearing flags for the Riff host contract. Content/card/completion
 *  files are not message attachments for the client's ④ heuristic, but the
 *  Riff protocol uploads and rewrites them just like attachments. */
export const SEND_UPLOAD_FLAGS: Record<string, true> = {
  ...SEND_FILE_FLAGS,
  '--content-file': true,
  '--card-file': true,
  '--completion-proposal-file': true,
};

export const SEND_IMAGE_FLAGS = ['--image', '--images'] as const;
export const SEND_FILE_ATTACHMENT_FLAGS = ['--file', '--files'] as const;
export const SEND_VIDEO_FLAGS = ['--video', '--videos'] as const;
export const SEND_VIDEO_COVER_FLAGS = ['--video-cover', '--video-covers'] as const;

export interface SendAttachmentOccurrence {
  flag: string;
  value: string;
  form: 'space' | 'equals';
}

export interface SendInvocation {
  argv: string[];
  freeHelpRequested: boolean;
  rawDoubleDashToken: boolean;
  flags: Record<string, string[]>;
  positionals: string[];
  attachmentOccurrences: SendAttachmentOccurrence[];
  bodySource: 'card' | 'content-file' | 'stdin' | 'positional';
  arityErrors: string[];
}

export interface SendAttachments {
  images: string[];
  files: string[];
  videos: string[];
  videoCovers: string[];
}

export interface ClientSendPlan {
  invocation: SendInvocation;
  attachments: SendAttachments;
  contentFile?: string;
  cardFile?: string;
  cardJson?: string;
  stdinContent?: string;
}

export interface HostSendPlan {
  invocation: SendInvocation;
  attachments: SendAttachments;
  uploadIndexes: number[];
}

export type SendValidation<T> =
  | { ok: true; plan: T }
  | { ok: false; message: string };

export type StatFile = (token: string, cwd: string) => 'file' | 'not-file';

/** The one stat policy used by the client preflight. Follows symlinks (the
 *  same way attachment upload does), treats directories/FIFOs/sockets/devices
 *  as not-files, and never throws: a permission or transient filesystem error
 *  must not crash the CLI. Callers inject a fake in tests. */
export function defaultStatFile(token: string, cwd: string): 'file' | 'not-file' {
  try {
    return statSync(resolve(cwd, token)).isFile() ? 'file' : 'not-file';
  } catch {
    return 'not-file';
  }
}

function pushFlag(flags: Record<string, string[]>, name: string, values: string[]): void {
  flags[name] = [...(flags[name] ?? []), ...values];
}

export function groupSendAttachments(invocation: SendInvocation): SendAttachments {
  const valuesFor = (flags: readonly string[]) => invocation.attachmentOccurrences
    .filter(occurrence => flags.includes(occurrence.flag))
    .map(occurrence => occurrence.value);
  return {
    images: valuesFor(SEND_IMAGE_FLAGS),
    files: valuesFor(SEND_FILE_ATTACHMENT_FLAGS),
    videos: valuesFor(SEND_VIDEO_FLAGS),
    videoCovers: valuesFor(SEND_VIDEO_COVER_FLAGS),
  };
}

/** Tokenize `botmux send` argv (the part after the `send` subcommand). */
function missingValueMessage(name: string): string {
  if (name === '--image-mode') return '--image-mode 仅支持 fit_horizontal|medium|small|tiny。';
  if (name === '--response-kind') return '--response-kind 仅支持 progress|final|auxiliary。';
  return SEND_FILE_FLAGS[name]
    ? `${name} 缺少值；多个附件请重复写 ${name} <path>。`
    : `${name} 缺少值。`;
}

export function parseSendInvocation(argv: string[]): SendInvocation {
  const flags: Record<string, string[]> = {};
  const positionals: string[] = [];
  const attachmentOccurrences: SendAttachmentOccurrence[] = [];
  const arityErrors: string[] = [];
  const rawDoubleDashToken = argv.includes('--');
  let freeHelpRequested = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      // P0 blanket ban; do not let the following token become a body here.
      continue;
    }
    if (token === '--help' || token === '-h') {
      freeHelpRequested = true;
      continue;
    }
    if (!token.startsWith('--')) {
      // `-` remains a positional; `-h` was handled above. Other single-dash
      // tokens stay positional so message text such as `-5 degrees` survives.
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    const spec = KNOWN_FLAGS.get(name);
    if (!spec) {
      arityErrors.push(`未知参数 ${name}；可用 --help 查看。`);
      // Unknown flags are not allowed to consume the next token: keeping it
      // visible lets a later free `--help` win and avoids swallowing body text.
      continue;
    }

    if (spec.kind === 'bool') {
      if (inline !== undefined) arityErrors.push(`${name} 不接受值。`);
      pushFlag(flags, name, []);
      continue;
    }

    if (spec.kind === 'optional') {
      pushFlag(flags, name, inline !== undefined ? [inline] : []);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next === '-h' || next.startsWith('--')) {
        arityErrors.push(missingValueMessage(name));
        // Consume a flag-shaped token so a value-position `--help` cannot
        // masquerade as free help.
        if (next !== undefined && next !== '--') i++;
        continue;
      }
      value = next;
      i++;
    }
    if (value === '') {
      arityErrors.push(missingValueMessage(name));
      continue;
    }
    pushFlag(flags, name, [value]);
    if (SEND_UPLOAD_FLAGS[name]) {
      attachmentOccurrences.push({
        flag: name,
        value,
        form: inline !== undefined ? 'equals' : 'space',
      });
    }
  }

  const bodySource: SendInvocation['bodySource'] = Object.hasOwn(flags, '--card-file') || Object.hasOwn(flags, '--card-json')
    ? 'card'
    : Object.hasOwn(flags, '--content-file')
      ? 'content-file'
      : positionals.length === 1 && positionals[0] === '-'
        ? 'stdin'
        : positionals.length > 0 ? 'positional' : 'stdin';

  return {
    argv,
    freeHelpRequested,
    rawDoubleDashToken,
    flags,
    positionals,
    attachmentOccurrences,
    bodySource,
    arityErrors,
  };
}

/** A positional token that is almost certainly a file path rather than prose.
 *  The ④ heuristic already stats existing files; this catches the case where a
 *  mistyped/missing attachment path does not exist on the client (and Riff's
 *  host, which deliberately never stats). Keep the list deliberately narrow:
 *  explicit path syntax or a common attachment extension. */
function looksLikePathToken(token: string): boolean {
  const value = token.trim();
  if (!value) return false;
  const hasCommonExt = /\.(?:sql|csv|tsv|jsonl?|md|txt|log|ya?ml|toml|ini|png|jpe?g|gif|webp|bmp|svg|pdf|zip|tar|gz|tgz|bz2|xz|mp4|mov|avi|webm|m4v|xlsx?|docx?|pptx?|html?|sh|py|ts|js|go|rs|java|c|cc|cpp|h)$/i.test(value);
  const prose = /[\s\u3000-\u9fff\uff00-\uffef]/.test(value) || value.includes('://');
  const explicitPrefix = value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\');
  if (value === '.' || value === '..') return true;
  // An explicit prefix proves path shape, but a normal sentence can also start
  // with one (`/help 是命令`, `./build.sh 跑过了`). Keep those as prose unless
  // the token also carries a file extension; the explicit-prefix + extension
  // case is exactly the missing/spaced path this guard must reject.
  if (explicitPrefix) return !prose || hasCommonExt;
  if (prose) return false;
  return hasCommonExt;
}

function findClientRiffPlaceholder(invocation: SendInvocation): string | undefined {
  for (const token of invocation.argv) {
    if (isRiffUploadPlaceholder(token, 'client-loose')) return token;
    const equals = token.indexOf('=');
    if (equals >= 0 && isRiffUploadPlaceholder(token.slice(equals + 1), 'client-loose')) {
      return token.slice(equals + 1);
    }
  }
  for (const values of Object.values(invocation.flags)) {
    for (const value of values) {
      if (isRiffUploadPlaceholder(value, 'client-loose')) return value;
    }
  }
  return undefined;
}

/** Client-side validation: Riff placeholders are never legal in the original
 *  argv, a lone `-` means stdin, and the positional-file heuristic rejects
 *  multi-path spelling errors. `--content-file -` is rejected explicitly. */
export function validateClientSendInvocation(
  invocation: SendInvocation,
  opts: { cwd: string; statFile?: StatFile },
): SendValidation<ClientSendPlan> {
  if (invocation.rawDoubleDashToken) {
    return { ok: false, message: "botmux send: '--' 分隔符尚未支持；正文以 -- 开头请用 --content-file 或 heredoc。" };
  }
  if (invocation.arityErrors[0]) return { ok: false, message: `botmux send: ${invocation.arityErrors[0]}` };

  const imageMode = invocation.flags['--image-mode']?.[0];
  if (imageMode !== undefined && !['fit_horizontal', 'medium', 'small', 'tiny'].includes(imageMode)) {
    return { ok: false, message: 'botmux send: --image-mode 仅支持 fit_horizontal|medium|small|tiny。' };
  }
  const responseKind = invocation.flags['--response-kind']?.[0];
  if (responseKind !== undefined && !['progress', 'final', 'auxiliary'].includes(responseKind)) {
    return { ok: false, message: 'botmux send: --response-kind 仅支持 progress|final|auxiliary。' };
  }

  const placeholder = findClientRiffPlaceholder(invocation);
  if (placeholder) {
    return {
      ok: false,
      message: `botmux send: 检测到 riff-upload 占位符（${placeholder}）；这是 Riff 内部上传引用，请传真实本地路径，或改用 --content-file。`,
    };
  }

  const contentFile = invocation.flags['--content-file']?.[0];
  if (contentFile === '-') {
    return {
      ok: false,
      message: "botmux send: --content-file 不支持 '-'；多行正文请直接用 botmux send <<'EOF' … EOF，或用裸 '-' 作为唯一位置参数。",
    };
  }

  if (invocation.positionals.includes('-')
    && !(invocation.bodySource === 'stdin' && invocation.positionals.length === 1)) {
    return {
      ok: false,
      message: "botmux send: '-' 只能作为唯一位置参数表示 stdin，不能与其它正文/参数混用；请把正文放到 heredoc/stdin 或 --content-file。",
    };
  }

  if ((Object.hasOwn(invocation.flags, '--card-file') || Object.hasOwn(invocation.flags, '--card-json')) && invocation.positionals.length > 0) {
    return {
      ok: false,
      message: 'botmux send: --card-file/--card-json 发送自定义卡片时不接受正文参数；卡片内容请写入 JSON',
    };
  }

  const attachments = groupSendAttachments(invocation);
  if ((attachments.images.length + attachments.files.length + attachments.videos.length + attachments.videoCovers.length) > 0 && invocation.positionals.length > 0) {
    const statFile = opts.statFile ?? defaultStatFile;
    const allFiles = invocation.positionals.every(token => {
      try { return statFile(token, opts.cwd) === 'file'; } catch { return false; }
    });
    const pathLike = invocation.positionals.some(looksLikePathToken);
    if (allFiles || pathLike) {
      return {
        ok: false,
        message: `botmux send: 检测到附件 flag 后面的额外路径被当成了正文：${invocation.positionals.join(' ')}。多个附件请重复写 --files/--images（例如 --files a --files b）；正文请用 heredoc/stdin 或 --content-file。`,
      };
    }
  }

  return {
    ok: true,
    plan: {
      invocation,
      attachments,
      ...(contentFile !== undefined ? { contentFile } : {}),
      ...(invocation.flags['--card-file']?.[0] !== undefined ? { cardFile: invocation.flags['--card-file'][0] } : {}),
      ...(invocation.flags['--card-json']?.[0] !== undefined ? { cardJson: invocation.flags['--card-json'][0] } : {}),
    },
  };
}

/** Host-side validation: no stat and no ④. Placeholders are legal only as
 *  separate values of file flags, must match the strict form, and must form a
 *  bijection with the upload manifest. */
export function validateHostSendInvocation(
  invocation: SendInvocation,
  opts: { uploads: readonly { name: string }[] },
): SendValidation<HostSendPlan> {
  if (invocation.rawDoubleDashToken) {
    return { ok: false, message: "riff host: '--' 分隔符尚未支持。" };
  }
  if (invocation.arityErrors[0]) return { ok: false, message: `riff host: ${invocation.arityErrors[0]}` };
  const contentFile = invocation.flags['--content-file']?.[0];
  if (contentFile === '-') {
    return { ok: false, message: "riff host: --content-file 不支持 '-'。" };
  }

  const used = new Set<number>();
  for (const occurrence of invocation.attachmentOccurrences) {
    if (occurrence.form !== 'space') {
      return { ok: false, message: `riff host: ${occurrence.flag} 需要独立的路径值。` };
    }
    if (!isRiffUploadPlaceholder(occurrence.value, 'host-strict')) {
      return { ok: false, message: `riff host: ${occurrence.flag} 只接受 riff-upload:<index>，不接受真实路径。` };
    }
    const index = parseRiffUploadIndex(occurrence.value);
    if (index === undefined || index >= opts.uploads.length) {
      return { ok: false, message: `riff host: riff-upload 索引越界（${occurrence.value}）。` };
    }
    if (used.has(index)) {
      return { ok: false, message: `riff host: riff-upload 索引重复（${occurrence.value}）。` };
    }
    used.add(index);
  }
  if (used.size !== opts.uploads.length) {
    return { ok: false, message: `riff host: 有 ${opts.uploads.length - used.size} 个上传未被引用。` };
  }

  for (const token of invocation.positionals) {
    if (isRiffUploadPlaceholder(token, 'client-loose')) {
      return { ok: false, message: `riff host: placeholder 不能出现在正文里（${token}）。` };
    }
  }

  for (const [flag, values] of Object.entries(invocation.flags)) {
    if (SEND_UPLOAD_FLAGS[flag]) continue;
    for (const value of values) {
      if (isRiffUploadPlaceholder(value, 'client-loose')) {
        return { ok: false, message: `riff host: placeholder 只能作为附件 flag 的值（${flag}）。` };
      }
    }
  }
  for (const token of invocation.argv) {
    const equals = token.indexOf('=');
    if (equals >= 0 && isRiffUploadPlaceholder(token.slice(equals + 1), 'client-loose')) {
      const name = token.slice(0, equals);
      if (!SEND_UPLOAD_FLAGS[name]) {
        return { ok: false, message: `riff host: placeholder 只能作为附件 flag 的值（${name}）。` };
      }
    }
  }

  return {
    ok: true,
    plan: {
      invocation,
      attachments: groupSendAttachments(invocation),
      uploadIndexes: [...used].sort((a, b) => a - b),
    },
  };
}
