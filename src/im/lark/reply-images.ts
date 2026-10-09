import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectImageFormat } from '../../core/attachment-image-format.js';
import { resolveCardMarkdownImages } from './md-card.js';
import { logger } from '../../utils/logger.js';

// Automatic transcript forwarding has a narrower budget than explicit --images.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_IMAGES = 8;

export interface ReplyImageState {
  omitImages: boolean;
  uploads?: Map<string, Promise<string | undefined>>;
  uploadCount?: number;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Read a bounded, pinned regular file. Both lexical and real paths must stay
 * inside this session's workspace; symlinks/hardlinks cannot grant access to
 * unrelated host files. Upload the inspected bytes, never reopen the pathname. */
function readWorkspaceImage(root: string, workingDir: string, source: string): Buffer | undefined {
  const decoded = source.startsWith('file:') ? fileURLToPath(source) : decodeURIComponent(source);
  if ((!isAbsolute(decoded) && /^[a-z][a-z\d+.-]*:/i.test(decoded))
    || decoded.startsWith('//') || decoded.startsWith('\\\\')) return;
  const candidate = resolve(workingDir, decoded);
  if (!isWithin(root, candidate) && !isWithin(resolve(workingDir), candidate)) return;
  const path = realpathSync(candidate);
  if (!isWithin(root, path)) return;
  const observed = lstatSync(path);
  if (!observed.isFile() || observed.nlink !== 1 || observed.size <= 0 || observed.size > MAX_IMAGE_BYTES) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (before.dev !== observed.dev || before.ino !== observed.ino || before.size !== observed.size) return;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return;
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || realpathSync(candidate) !== path || !detectImageFormat(bytes)) return;
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export async function resolveReplyImages(
  markdown: string,
  options: {
    workingDir: string;
    state: ReplyImageState;
    upload: (bytes: Buffer) => Promise<string>;
    owns: () => boolean;
  },
): Promise<string> {
  if (options.state.omitImages || !markdown.includes('![')) return markdown;
  let root: string;
  try {
    root = realpathSync(options.workingDir);
    // A home or filesystem root is not a bounded project workspace.
    if (resolve(root, '..') === root || root === realpathSync(homedir())) return markdown;
  } catch { return markdown; }
  const uploads = options.state.uploads ??= new Map();
  return resolveCardMarkdownImages(markdown, async source => {
    if (!options.owns()) return;
    const existing = uploads.get(source);
    if (existing) return existing;
    if ((options.state.uploadCount ?? 0) >= MAX_REPLY_IMAGES) return;
    const pending = (async () => {
      try {
        const image = readWorkspaceImage(root, options.workingDir, source);
        if (!image || !options.owns()) return;
        options.state.uploadCount = (options.state.uploadCount ?? 0) + 1;
        return await options.upload(image);
      } catch {
        logger.warn('Reply image could not be read or uploaded; preserving the text fallback');
        return undefined;
      }
    })();
    uploads.set(source, pending);
    return pending;
  });
}
