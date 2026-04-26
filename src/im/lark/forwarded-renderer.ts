/**
 * Pure renderer for forwarded message trees.
 *
 * Input is a tree of ForwardedNode (built in daemon.ts by walking Lark's
 * im.message.get response). Output is an XML block with deduplicated
 * participants — each unique sender appears once in <participants>, then
 * messages reference them by short alias (A, B, C...) saving tokens vs.
 * the previous `--- ${open_id} ---` per-line format.
 */

export interface ForwardedNode {
  /** open_id of the sender (for both user and app types). May be empty if Lark omits it. */
  senderOpenId: string;
  senderType: 'user' | 'app' | 'unknown';
  /** Optional human-readable name (resolved when sender is one of our bots / chat-mate bots). */
  senderName?: string;
  /** Leaf message text content — present when this is not a nested merged-forward wrapper. */
  content?: string;
  /** Children — present when this node IS a nested merged-forward, replacing `content`. */
  children?: ForwardedNode[];
}

interface ParticipantInfo {
  alias: string;
  type: 'user' | 'app' | 'unknown';
  name?: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A → Z → AA → AB → ... so participant indexing never runs out. */
function aliasFor(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function collectParticipants(
  nodes: ForwardedNode[],
  map: Map<string, ParticipantInfo> = new Map(),
  unknownCounter: { n: number } = { n: 0 },
): Map<string, ParticipantInfo> {
  for (const node of nodes) {
    // Group all senders missing an open_id under stable per-occurrence keys
    // so they each get their own alias instead of collapsing into one.
    const key = node.senderOpenId || `__unknown_${unknownCounter.n++}__`;
    if (!map.has(key)) {
      const info: ParticipantInfo = {
        alias: aliasFor(map.size),
        type: node.senderType,
      };
      if (node.senderName) info.name = node.senderName;
      map.set(key, info);
    } else if (node.senderName && !map.get(key)!.name) {
      // Backfill name if a later occurrence has it but the first didn't.
      map.get(key)!.name = node.senderName;
    }
    if (node.children) collectParticipants(node.children, map, unknownCounter);
  }
  return map;
}

function renderParticipants(map: Map<string, ParticipantInfo>): string {
  const items: string[] = [];
  for (const [key, info] of map) {
    const openIdAttr = key.startsWith('__unknown_') ? '' : ` open_id="${xmlEscape(key)}"`;
    const nameAttr = info.name ? ` name="${xmlEscape(info.name)}"` : '';
    items.push(`  <p id="${info.alias}"${openIdAttr} type="${info.type}"${nameAttr} />`);
  }
  return `<participants>\n${items.join('\n')}\n</participants>`;
}

function renderNodes(
  nodes: ForwardedNode[],
  map: Map<string, ParticipantInfo>,
  unknownCounter: { n: number },
  indent: string = '',
): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const key = node.senderOpenId || `__unknown_${unknownCounter.n++}__`;
    const alias = map.get(key)?.alias ?? '?';
    if (node.children) {
      lines.push(`${indent}<msg from="${alias}" type="merged_forward">`);
      lines.push(renderNodes(node.children, map, unknownCounter, indent + '  '));
      lines.push(`${indent}</msg>`);
    } else {
      const text = node.content ?? '';
      // Multiline content: keep inner newlines, indent each line under <msg>
      // so the XML stays human-scannable. We don't escape user content text
      // (& < > etc.) — that would corrupt code blocks; the model is tolerant.
      if (text.includes('\n')) {
        const inner = text.split('\n').map(l => `${indent}  ${l}`).join('\n');
        lines.push(`${indent}<msg from="${alias}">`);
        lines.push(inner);
        lines.push(`${indent}</msg>`);
      } else {
        lines.push(`${indent}<msg from="${alias}">${text}</msg>`);
      }
    }
  }
  return lines.join('\n');
}

/** Render a forwarded message tree as a single XML block. */
export function renderForwardedXml(nodes: ForwardedNode[]): string {
  if (nodes.length === 0) return '<forwarded_messages />';
  // Two passes share an unknown counter so collect / render assign the same
  // synthetic key to the same anonymous occurrence.
  const collectCounter = { n: 0 };
  const participants = collectParticipants(nodes, new Map(), collectCounter);
  const renderCounter = { n: 0 };
  const body = renderNodes(nodes, participants, renderCounter);
  return [
    '<forwarded_messages>',
    renderParticipants(participants),
    body,
    '</forwarded_messages>',
  ].join('\n');
}
