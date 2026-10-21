import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { LarkAttachment, CliTurnPayload } from '../types.js';
import type { LinkRefRuntime } from '../services/link-ref-runtime.js';
import type {
  LinkRefMode,
  LinkRefSourceInput,
  LinkRefSourceType,
  LinkRefTurnKey,
} from '../services/link-ref-types.js';

const LINK_REF_ATTACHMENT_MAX_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html',
  '.csv', '.tsv', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs',
  '.sh', '.zsh', '.bash', '.sql', '.toml', '.ini', '.cfg', '.log',
]);

function attachmentLooksTextual(attachment: LarkAttachment): boolean {
  const mime = attachment.mimeType?.toLowerCase();
  return mime?.startsWith('text/') === true
    || mime === 'application/json'
    || mime === 'application/xml'
    || mime === 'application/yaml'
    || TEXT_EXTENSIONS.has(extname(attachment.name || attachment.path).toLowerCase());
}

export function readLinkRefAttachmentText(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > LINK_REF_ATTACHMENT_MAX_BYTES) return undefined;
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) return undefined;
    if (bytes.includes(0)) return undefined;
    return bytes.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function initialLinkRefSources(input: {
  userText?: string;
  userSourceType?: Extract<LinkRefSourceType, 'user_message' | 'card'>;
  groupContext?: string;
  cardValue?: unknown;
  historyValue?: unknown;
  quotedValue?: unknown;
  attachments?: readonly LarkAttachment[];
  publicSystemDocUrls?: readonly string[];
  hiddenSystemInstruction?: string;
  skillInternalText?: string;
}): LinkRefSourceInput[] {
  const sources: LinkRefSourceInput[] = [];
  if (input.userText) {
    sources.push({ sourceType: input.userSourceType ?? 'user_message', kind: 'text', text: input.userText });
  }
  if (input.groupContext) sources.push({ sourceType: 'group_context', kind: 'text', text: input.groupContext });
  if (input.cardValue !== undefined) sources.push({ sourceType: 'card', kind: 'structured', value: input.cardValue });
  if (input.historyValue !== undefined) sources.push({ sourceType: 'history', kind: 'structured', value: input.historyValue });
  if (input.quotedValue !== undefined) sources.push({ sourceType: 'quoted', kind: 'structured', value: input.quotedValue });
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === 'file' && attachmentLooksTextual(attachment)) {
      sources.push({ sourceType: 'attachment', kind: 'attachment_text', path: attachment.path, sourceId: attachment.resourceKey ?? attachment.name });
    }
  }
  for (const url of input.publicSystemDocUrls ?? []) {
    sources.push({ sourceType: 'public_system_doc', kind: 'text', text: url });
  }
  return sources;
}

function materializeAttachmentSources(sources: readonly LinkRefSourceInput[]): LinkRefSourceInput[] {
  return sources.flatMap((source): LinkRefSourceInput[] => {
    if (source.kind !== 'attachment_text') return [source];
    const text = readLinkRefAttachmentText(source.path);
    return text === undefined
      ? []
      : [{ sourceType: 'attachment', kind: 'text', text, sourceId: source.sourceId }];
  });
}

export function prepareLinkRefTurnPayload(input: {
  runtime: LinkRefRuntime;
  key: LinkRefTurnKey;
  mode: LinkRefMode;
  payload: CliTurnPayload;
}): CliTurnPayload {
  return input.runtime.prepareTurn({
    key: input.key,
    mode: input.mode,
    payload: input.payload.linkRefs?.sources
      ? {
          ...input.payload,
          linkRefs: {
            mode: input.mode,
            sources: materializeAttachmentSources(input.payload.linkRefs.sources),
          },
        }
      : input.payload,
  });
}
