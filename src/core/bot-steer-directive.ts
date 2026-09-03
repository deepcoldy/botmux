export interface ParsedBotSteerDirective {
  requested: boolean;
  /** Message body with the control directive removed. */
  content: string;
}

/**
 * Consume the generic bot-to-bot `@steer` control directive.
 *
 * The directive must be the first semantic line, optionally following one or
 * more leading @recipient lines emitted by Lark. Both forms are accepted:
 *
 *   @steer
 *   adjust the current task
 *
 *   @TargetBot
 *   @steer adjust the current task
 *
 * This parser is deliberately transport-only and language-neutral. It does not
 * authorize anything by itself; the daemon additionally requires a positively
 * classified foreign-bot sender and applies the existing control-lane gates.
 */
export function parseBotSteerDirective(content: string): ParsedBotSteerDirective {
  const lines = content.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index++;

  while (index < lines.length) {
    const line = lines[index]!.trim();
    const match = /^@steer(?:\s+(.*))?$/i.exec(line);
    if (match) {
      const inlineContent = match[1]?.trim();
      if (inlineContent) lines[index] = inlineContent;
      else lines.splice(index, 1);
      return { requested: true, content: lines.join('\n') };
    }
    if (!line.startsWith('@')) break;
    index++;
    while (index < lines.length && !lines[index]!.trim()) index++;
  }

  return { requested: false, content };
}

/** Add the wire directive once; used by generic sender-side convenience flags. */
export function withBotSteerDirective(content: string): string {
  return parseBotSteerDirective(content).requested
    ? content
    : `@steer\n${content}`;
}
