import MarkdownIt from 'markdown-it';
import { isIP } from 'node:net';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { posix } from 'node:path';
import { extractHttpUrlSpans } from '../../services/link-ref-extractor.js';
import { OutputDeliveryTerminalError } from '../../services/output-delivery-coordinator.js';
import { FEISHU_IMG_KEY } from './card-markdown-image-references.js';

/** Presentation policy only: upload sources and opaque callback values are
 * execution inputs, not prose. No filesystem probing or DNS lookup is needed. */
export interface LocalAddressContext {
  workspaceRoots?: readonly string[];
  localHosts?: readonly string[];
  internalFileLabel?: string;
  unavailableLinkLabel?: string;
  /** Capability links the host builds for its own pages. Consulted only for
   * card link fields; prose keeps the text policy. */
  hostIssuedLink?: (url: string) => boolean;
  /** Check card link fields and leave prose as written. The transport sees
   * host-written bodies too; prose is rewritten where model output enters. */
  linkFieldsOnly?: boolean;
}

interface Context {
  roots: string[];
  hosts: Set<string>;
  hostPaths: RegExp;
  hostNames: RegExp;
  internalFile: string;
  unavailableLink: string;
  hostIssuedLink?: (url: string) => boolean;
  prose: boolean;
}

export class LocalAddressOutboundError extends OutputDeliveryTerminalError {
  readonly code = 'LOCAL_ADDRESS_OUTBOUND_REJECTED';
  constructor() {
    super('LOCAL_ADDRESS_OUTBOUND_REJECTED: use an attachment or an accessible remote URL; local jump targets cannot be sent.');
    this.name = 'LocalAddressOutboundError';
  }
}

const md = new MarkdownIt({ html: false, linkify: false });
// Detect file links too; the renderer's default protocol filter would hide them.
md.validateLink = () => true;
const LOCAL_SCHEME = /^(?:file|vscode(?:-insiders)?|vscode-remote|cursor|idea|jetbrains|subl|atom|skill):/i;
const ROOT_PATH = /^(?:\/(?:home|Users|root|tmp|private|var|run|mnt|media|Volumes|opt|srv|etc|usr|bin|sbin|dev|proc|sys|data\d*|workspace|workspaces)(?:\/|$)|~(?:\/|$)|\$(?:HOME|\{HOME\})(?:\/|$)|%USERPROFILE%(?:[\\/]|$)|[a-z]:[\\/]|\\\\)/i;
// /dev streams and the kernel's /proc and /sys views name no user file, so shell
// text like `2>/dev/null` stays readable. A process's cwd and root under /proc
// lead back into the filesystem and stay covered.
const ADDRESS_TOKEN = /(?:\b(?:file|vscode(?:-insiders)?|vscode-remote|cursor|idea|jetbrains|subl|atom|skill):[^\s<>"'\x60，。、；！？]*|(?<![\w/])(?!\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)(?![\w.\/-])|\/(?:proc|sys)(?:\/|$)(?!(?:self|thread-self|\d+)\/(?:task\/\d+\/)?(?:cwd|root)(?:\/|$)))(?:\/(?:home|Users|root|tmp|private|var|run|mnt|media|Volumes|opt|srv|etc|usr|bin|sbin|dev|proc|sys|data\d*|workspace|workspaces)(?=\/|$)|~(?=\/|$)|\$(?:HOME|\{HOME\})(?=\/|$)|%USERPROFILE%(?=[\\/]|$)|[a-z]:[\\/]|\\\\)[^\s<>"'\x60，。、；！？()[\]]*)/giu;
const LINK_KEYS = new Set(['href', 'url', 'pc_url', 'android_url', 'ios_url', 'default_url']);
const STRUCTURAL_KEYS = new Set([
  'tag', 'element_id', 'name', 'data_type', 'img_key', 'image_key', 'file_key',
  'template_id', 'template_version_name', 'uuid', 'schema', 'user_id', 'open_id',
  'union_id', 'chat_id', 'message_id', 'type', 'mode', 'style', 'token',
]);
const OPAQUE_SUBTREES = new Set(['value', 'confirm_value', 'form_value']);

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function escaped(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function contextFor(input: LocalAddressContext): Context {
  const hosts = new Set([hostname(), hostname().split('.')[0]!, ...(input.localHosts ?? [])].map(normalizedHost));
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) hosts.add(normalizedHost(entry.address));
  }
  // WHATWG normalizes IPv4-mapped IPv6 to hex; both spellings still name
  // the same host interface and must share its presentation policy.
  for (const host of [...hosts]) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) continue;
    const octets = host.split('.').map(Number);
    hosts.add('::ffff:' + host);
    hosts.add('::ffff:' + ((octets[0]! << 8) | octets[1]!).toString(16)
      + ':' + ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const roots = (input.workspaceRoots ?? [process.cwd()]).map(root => root.replace(/\\/g, '/').replace(/\/+$/, ''));
  const hostPaths = [...roots, homedir()].filter(root => root && root !== '/').map(escaped);
  const hostNames = ['0.0.0.0', '::', '::1', ...hosts].filter(host => isIP(host))
    .map(host => host.includes(':') ? '(?:\\[' + escaped(host) + '\\]|' + escaped(host) + ')' : escaped(host));
  const mappedLoopback = '::ffff:(?:127(?:\\.\\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})';
  hostNames.push('(?:\\[' + mappedLoopback + '\\]|' + mappedLoopback + ')');
  // Machine names are often ordinary words (ubuntu, master, devbox). In prose
  // one only names this host when it carries a port; URLs are judged by authority.
  const machineNames = [...hosts].filter(host => host && !isIP(host)).map(escaped);
  const machineAddress = machineNames.length ? '|(?:' + machineNames.join('|') + '):\\d+' : '';
  return {
    roots,
    hosts,
    hostPaths: new RegExp('(?<![\\w/])(?:' + hostPaths.join('|') + ')(?=/|$)[^\\s<>"\\x27\\x60，。、；！？()[\\]]*', 'gu'),
    hostNames: new RegExp('(?<![\\w.-])(?:(?:localhost|127(?:\\.\\d{1,3}){3}|' + hostNames.join('|') + ')(?::\\d+)?' + machineAddress + ')(?![\\w.:-])(?:/[^\\s<>"\\x27\\x60，。、；！？()[\\]]*)?', 'giu'),
    internalFile: input.internalFileLabel ?? '【内部文件】',
    unavailableLink: input.unavailableLinkLabel ?? '（未提供可访问链接）',
    hostIssuedLink: input.hostIssuedLink,
    prose: !input.linkFieldsOnly,
  };
}

function decoded(value: string): string {
  let out = md.utils.unescapeAll(value.trim());
  // Bounded decoding recognizes percent-encoded local destinations without
  // changing a remote business URL's spelling or query parameters.
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch { break; }
  }
  return out;
}

function localServiceUrl(value: string, ctx: Context): boolean {
  try {
    const url = new URL(value);
    const host = normalizedHost(url.hostname);
    return host === 'localhost' || host.endsWith('.localhost')
      || host === '0.0.0.0' || host === '::' || host === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(host)
      || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/i.test(host)
      || ctx.hosts.has(host);
  } catch { return false; }
}

// Remote wrappers (Lark's open-in-client link, login redirects) carry their
// target in the query, path or fragment; a local target makes the link local.
const NESTED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#&"'<>\\]+/gi;

function carriesLocalUrl(target: string, ctx: Context): boolean {
  if (/file:\/\//i.test(target)) return true;
  for (const [nested] of target.matchAll(NESTED_URL)) {
    if (localServiceUrl(nested, ctx)) return true;
  }
  return false;
}

function inWorkspace(value: string, ctx: Context): string | undefined {
  const path = posix.normalize(decoded(value).replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, ''));
  for (const root of ctx.roots) {
    const normalized = posix.normalize(root);
    if (normalized !== '/' && path.startsWith(normalized + '/')) {
      const relative = path.slice(normalized.length + 1);
      const position = /:\d+(?::\d+)?$/.exec(value)?.[0] ?? '';
      return relative + position;
    }
  }
  return undefined;
}

function localDestination(value: string, ctx: Context): boolean {
  const target = decoded(value);
  if (target.startsWith('//')) return localServiceUrl('https:' + target, ctx) || carriesLocalUrl(target, ctx);
  if (LOCAL_SCHEME.test(target) || ROOT_PATH.test(target) || inWorkspace(target, ctx)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return localServiceUrl(target, ctx) || carriesLocalUrl(target, ctx);
  // A link needs a remote scheme to be useful in Lark. Relative source text
  // and API paths outside link destinations are left alone.
  return !!target && !target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

function localLinkLabel(label: string, target: string, ctx: Context): string {
  if (/(?:^|[\\/])SKILL\.md(?:[?#:]|$)/i.test(decoded(target))) return label;
  const relative = inWorkspace(target, ctx);
  if (relative) return label === relative ? relative : label + ' (' + relative + ')';
  return label + ctx.unavailableLink;
}

/** Use MarkdownIt's destination/label helpers so angle brackets, escaped
 * punctuation and nested parentheses follow the renderer's syntax. */
function scrubLinks(input: string, ctx: Context): string {
  if (!input.includes('[')) return input;
  const env: { references?: Record<string, { href: string }> } = {};
  md.parse(input, env);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const localDefinitions = new Set<string>();
  for (const [name, reference] of Object.entries(env.references ?? {})) {
    if (localDestination(reference.href, ctx)) localDefinitions.add(name);
  }
  const state = new md.inline.State(input, md, env, []);
  for (let start = input.indexOf('['); start >= 0; start = input.indexOf('[', start + 1)) {
    const labelEnd = md.helpers.parseLinkLabel(state, start, true);
    if (labelEnd < 0) continue;
    const label = input.slice(start + 1, labelEnd);
    let pos = labelEnd + 1;
    let target: string | undefined;
    let end: number | undefined;
    if (input[pos] === '(') {
      pos++;
      while (/\s/.test(input[pos] ?? '') && pos < input.length) pos++;
      const destination = md.helpers.parseLinkDestination(input, pos, input.length);
      if (destination.ok) {
        target = destination.str;
        pos = destination.pos;
        while (pos < input.length && /\s/.test(input[pos]!)) pos++;
        if (input[pos] !== ')' && pos < input.length) {
          const title = md.helpers.parseLinkTitle(input, pos, input.length);
          if (title.ok) {
            pos = title.pos;
            while (pos < input.length && /\s/.test(input[pos]!)) pos++;
          }
        }
        if (input[pos] === ')') end = pos + 1;
        // A stream may end halfway through a local destination. Never emit it.
        else if (pos === input.length && localDestination(target, ctx)) end = input.length;
      } else if (input[pos] === '<' && !input.slice(pos + 1).includes('>')) {
        // Angle-bracket destinations can contain spaces. The parser rejects
        // an unfinished one, so consume the complete local tail ourselves.
        const unfinished = input.slice(pos + 1);
        if (localDestination(unfinished, ctx)) { target = unfinished; end = input.length; }
      }
    } else {
      let reference = label;
      if (input[pos] === '[') {
        const close = input.indexOf(']', pos + 1);
        if (close < 0) continue;
        reference = input.slice(pos + 1, close) || label;
        pos = close + 1;
      }
      const normalized = md.utils.normalizeReference(reference);
      if (localDefinitions.has(normalized)) {
        target = env.references![normalized]!.href;
        end = pos;
      }
    }
    if (target === undefined || end === undefined || !localDestination(target, ctx)) continue;
    const image = start > 0 && input[start - 1] === '!';
    // Feishu Markdown accepts uploaded image keys as native media sources.
    if (image && FEISHU_IMG_KEY.test(decoded(target))) continue;
    replacements.push({ start: image ? start - 1 : start, end, text: localLinkLabel(label, target, ctx) });
    start = end - 1;
  }
  let out = '';
  let cursor = 0;
  for (const replacement of replacements) {
    out += input.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  out += input.slice(cursor);
  if (localDefinitions.size) {
    out = out.replace(/^ {0,3}\[([^\]\n]+)\]:[^\n]*(?:\n|$)/gm, (line, name: string) =>
      localDefinitions.has(md.utils.normalizeReference(name)) ? '' : line);
  }
  return out;
}

function scrubText(input: string, ctx: Context): string {
  if (!ctx.prose) return input;
  const linked = scrubLinks(input, ctx);
  const scrubAddress = (address: string): string => {
    const trailing = /[.,;:]+$/.exec(address)?.[0] ?? '';
    const value = trailing ? address.slice(0, -trailing.length) : address;
    return (inWorkspace(value, ctx) ?? ctx.internalFile) + trailing;
  };
  const scrubSegment = (segment: string): string => segment
    .replace(ADDRESS_TOKEN, scrubAddress)
    .replace(ctx.hostPaths, scrubAddress)
    .replace(ctx.hostNames, ctx.internalFile);
  // URL spans are protected as whole strings: /home in a business URL is not
  // a host filesystem path. Only the URL's authority determines locality.
  let out = '';
  let cursor = 0;
  const spans = extractHttpUrlSpans(linked);
  // The link ledger excludes credentials. Locality checks must still inspect
  // such URLs, and protocol-relative web links must be protected too.
  for (const match of linked.matchAll(/[a-z][a-z0-9+.-]*:[^\s<>"'\x60，。、；！？]+|(?<![:/])\/\/(?=[a-z0-9[])[^\s<>"'\x60，。、；！？]+/giu)) {
    if (spans.some(span => span.start === match.index)) continue;
    const value = match[0].replace(/[)\].,;]+$/, '');
    try {
      const url = new URL(value.startsWith('//') ? 'https:' + value : value);
      if (!url.hostname || LOCAL_SCHEME.test(value)) continue;
      spans.push({ start: match.index!, end: match.index! + value.length, originalUrl: value });
    } catch { /* A non-URL path remains eligible for the path scan. */ }
  }
  spans.sort((a, b) => a.start - b.start);
  for (const span of spans) {
    // An outer span (`git+https://...`) already covers the http(s) span inside it.
    if (span.start < cursor) continue;
    out += scrubSegment(linked.slice(cursor, span.start));
    out += localServiceUrl(span.originalUrl.startsWith('//') ? 'https:' + span.originalUrl : span.originalUrl, ctx)
      || carriesLocalUrl(decoded(span.originalUrl), ctx)
      ? ctx.internalFile : span.originalUrl;
    cursor = span.end;
  }
  return out + scrubSegment(linked.slice(cursor));
}

export function sanitizeLocalAddressText(text: string, context: LocalAddressContext = {}): string {
  return scrubText(text, contextFor(context));
}

/** Lark's open-in-client link around one page: the terminal sidebar and the
 * workflow and decision-board entries wrap a host link this way. */
function larkWebUrlTarget(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || !/^applink\.(?:feishu\.cn|larksuite\.com)$/.test(url.hostname)
    || url.pathname !== '/client/web_url/open' || url.username || url.password || url.hash) return undefined;
  const params = [...url.searchParams];
  const targets = params.filter(([name]) => name === 'url');
  if (targets.length !== 1 || params.some(([name, param]) => name !== 'url' && !/^[\w.-]*$/.test(param))) return undefined;
  return targets[0]![1];
}

function hostLink(value: string, ctx: Context): boolean {
  if (!ctx.hostIssuedLink) return false;
  if (ctx.hostIssuedLink(value)) return true;
  const target = larkWebUrlTarget(value);
  return target !== undefined && ctx.hostIssuedLink(target);
}

function scrubNode(node: unknown, key: string | undefined, ctx: Context): unknown {
  if (typeof node === 'string') {
    if (key && STRUCTURAL_KEYS.has(key)) return node;
    if (key && LINK_KEYS.has(key)) {
      // Without a public external host, Web terminal and Dashboard buttons point
      // at this machine's own interface; only the host's own link shapes pass.
      if (localDestination(node, ctx) && !hostLink(node, ctx)) throw new LocalAddressOutboundError();
      return node;
    }
    return scrubText(node, ctx);
  }
  if (Array.isArray(node)) {
    if (key === 'rows') return node.map(row => row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).map(([name, cell]) => [name, scrubNode(cell, undefined, ctx)]))
      : scrubNode(row, undefined, ctx));
    return node.map(item => scrubNode(item, undefined, ctx));
  }
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [
    childKey, OPAQUE_SUBTREES.has(childKey) ? child : scrubNode(child, childKey, ctx),
  ]));
}

export function sanitizeLocalAddressNode<T>(node: T, context: LocalAddressContext = {}): T {
  return scrubNode(node, undefined, contextFor(context)) as T;
}

/** Card link fields of a body that point at this machine. A body the host
 * vetted before persisting it for replay trusts these when it is sent again. */
export function localJumpTargets(content: string, msgType: string, context: LocalAddressContext = {}): string[] {
  if (msgType !== 'interactive' && msgType !== 'post') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const ctx = contextFor(context);
  const found: string[] = [];
  const visit = (node: unknown, key: string | undefined): void => {
    if (typeof node === 'string') {
      if (key && LINK_KEYS.has(key) && localDestination(node, ctx)) found.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item, undefined);
    } else if (node && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(node)) if (!OPAQUE_SUBTREES.has(childKey)) visit(child, childKey);
    }
  };
  visit(parsed, undefined);
  return found;
}

export function prepareLocalAddressContent(
  content: string, msgType = 'text', context: LocalAddressContext = {},
): string {
  if (msgType === 'text') return sanitizeLocalAddressText(content, context);
  if (msgType !== 'interactive' && msgType !== 'post') return content;
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch {
    // A malformed safe body still gets the provider's normal validation;
    // malformed bodies carrying local addresses cannot skip the policy.
    if (sanitizeLocalAddressText(content, context) !== content) throw new LocalAddressOutboundError();
    return content;
  }
  const clean = sanitizeLocalAddressNode(parsed, context);
  return JSON.stringify(clean) === JSON.stringify(parsed) ? content : JSON.stringify(clean);
}
