/** TRAE renders a native skill token differently in submit history and the
 * display transcript. Keep the original text for display; these exact aliases
 * are receipt evidence only. A bare `$name` without a skill block is ordinary
 * text and must not be treated as a rewritten slash command. */
const SKILL_NAME = '[^\\s\\[\\]($)\\\\/]+';
const SKILL_LINK = new RegExp(`^([ \\t]*)\\[\\$(${SKILL_NAME})\\]\\((<[^\\r\\n>]+>|[^\\r\\n]+?SKILL\\.md)\\)(?=$|\\s)`);
const SKILL_TOKEN = new RegExp(`^([ \\t]*)\\$(${SKILL_NAME})(?=$|\\s)`);

function isSkillPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let path = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
  try { path = decodeURIComponent(path); } catch { return false; }
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) && /[\\/]SKILL\.md$/.test(path);
}

export function traexSkillInputAliases(text: string, content?: unknown): string[] | undefined {
  const link = SKILL_LINK.exec(text);
  if (link && isSkillPath(link[3])) {
    const body = text.slice(link[0].length);
    return [`${link[1]}/${link[2]}${body}`, `${link[1]}$${link[2]}${body}`];
  }
  const token = SKILL_TOKEN.exec(text);
  if (!token || !Array.isArray(content)) return undefined;
  // The display UserMessage carries the native skill object alongside its
  // text. Require that provenance and the same name, rather than rewriting
  // arbitrary dollar-prefixed prose or trusting an assistant's skill link.
  if (!content.some(block => block?.type === 'skill' && block.name === token[2] && isSkillPath(block.path))) {
    return undefined;
  }
  return [`${token[1]}/${token[2]}${text.slice(token[0].length)}`];
}

export function normaliseTraexInputNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function traexHistoryInputMatches(recordedText: string, expectedText: string): boolean {
  const expected = normaliseTraexInputNewlines(expectedText);
  return normaliseTraexInputNewlines(recordedText) === expected
    || (traexSkillInputAliases(recordedText)?.some(alias => normaliseTraexInputNewlines(alias) === expected) ?? false);
}
