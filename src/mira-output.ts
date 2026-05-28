type CisCtrlOpen = { index: number; close: string };

function stripLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return line.slice(0, end);
}

function collapseBlankLines(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n').map(stripLineEnd);
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (!blank) out.push('');
      blank = true;
    } else {
      out.push(line);
      blank = false;
    }
  }
  return out.join('\n').trim();
}

function nextCisCtrlOpen(lower: string, from: number): CisCtrlOpen | undefined {
  const raw = lower.indexOf('<cis-ctrl', from);
  const escaped = lower.indexOf('&lt;cis-ctrl', from);
  if (raw < 0 && escaped < 0) return undefined;
  if (escaped < 0 || (raw >= 0 && raw < escaped)) return { index: raw, close: '</cis-ctrl>' };
  return { index: escaped, close: '&lt;/cis-ctrl&gt;' };
}

function consumeFollowingOwnLineBreak(text: string, from: number, out: string): number {
  let pos = from;
  while (text[pos] === ' ' || text[pos] === '\t') pos++;
  if (out.length > 0 && !out.endsWith('\n')) return pos;
  if (text[pos] === '\r' && text[pos + 1] === '\n') return pos + 2;
  if (text[pos] === '\n') return pos + 1;
  return pos;
}

function stripCisCtrlBlocks(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let pos = 0;
  for (;;) {
    const open = nextCisCtrlOpen(lower, pos);
    if (!open) return out + text.slice(pos);
    out += text.slice(pos, open.index);

    const close = lower.indexOf(open.close, open.index);
    if (close < 0) return out;

    pos = consumeFollowingOwnLineBreak(text, close + open.close.length, out);
  }
}

export function sanitizeMiraFinalText(text: string): string {
  return collapseBlankLines(stripCisCtrlBlocks(text));
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function textFromContentParts(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(part => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const obj = part as Record<string, unknown>;
        return typeof obj.text === 'string' ? obj.text : textFromContentParts(obj.content) ?? '';
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('') : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  return textFromContentParts(obj.content);
}

function assistantTextFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const text = assistantTextFromValue(value[i]);
      if (text) return text;
    }
    return undefined;
  }

  const obj = value as Record<string, unknown>;
  const nestedMessage = obj.message;
  if (nestedMessage && typeof nestedMessage === 'object') {
    const nested = nestedMessage as Record<string, unknown>;
    if (nested.role === 'assistant') return textFromContentParts(nested.content);
  }
  if (obj.role === 'assistant') return textFromContentParts(obj.content);
  return undefined;
}

export function extractMiraHistoryFinalText(payload: unknown): string | undefined {
  const messages = (payload as { data?: { messages?: unknown } } | undefined)?.data?.messages;
  if (!Array.isArray(messages)) return undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { sender?: unknown; content?: unknown } | undefined;
    if (!message || message.sender !== 2) continue;
    const content = typeof message.content === 'string'
      ? parseJsonMaybe(message.content) ?? message.content
      : message.content;
    const text = assistantTextFromValue(content) ?? textFromContentParts(content);
    const sanitized = text ? sanitizeMiraFinalText(text) : '';
    if (sanitized) return sanitized;
  }
  return undefined;
}
