import MarkdownIt from 'markdown-it';

let parser: MarkdownIt | undefined;
const misplacedFence = /^([^`\r\n]*[^\s`][：:][ \t]*)(```(?:plain_text|plaintext|text|txt|json|bash|sh|shell|zsh|javascript|js|typescript|ts|python|py|yaml|yml|toml|sql))[ \t]*\r?$/im;
const closingFence = /^[ ]{0,3}`{3}[ \t]*\r?$/;

/** Display-only repair for complete CLI reply bodies, independent of the CLI.
 * Recover only a prose label ending in :/： followed by a misplaced fence with
 * an explicitly supported language and a nonempty, bounded, paired body.
 * CommonMark token maps protect existing code, quotes, lists and inline spans;
 * incomplete streams, unknown languages and ambiguous nested fences stay raw.
 * Callers retain original replies for history, exports and native delivery. */
export function repairReplyMarkdown(input: string): string {
  if (!input.includes('```') || !misplacedFence.test(input)) return input;
  let output = input;
  for (let repairs = 0; repairs < 16; repairs++) {
    const lines = output.split('\n');
    // The existing renderer recovers whole-line escaped fences. Classify the
    // same view so an escaped outer example remains protected; retain raw bytes.
    const classified = output.replace(/^[ ]{0,3}(?:\\`){3,}[^\n`]*$/gm, line => line.replace(/\\`/g, '`'));
    const tokens = (parser ??= new MarkdownIt({ html: false, linkify: false })).parse(classified, {});
    let repaired = false;
    for (let i = 0; i < tokens.length && !repaired; i++) {
      const paragraph = tokens[i];
      if (paragraph.type !== 'paragraph_open' || paragraph.level !== 0 || !paragraph.map) continue;
      // A paragraph containing literal inline code may be a Markdown tutorial.
      if (tokens[i + 1]?.children?.some(token => token.type === 'code_inline')) continue;
      for (let line = paragraph.map[0]; line < paragraph.map[1]; line++) {
        if (/^(?: {4}|\t)/.test(lines[line])) continue;
        const candidate = misplacedFence.exec(lines[line]);
        if (!candidate) continue;
        let nonempty = false;
        let bodySize = 0;
        for (let end = line + 1; end < lines.length && end <= line + 80; end++) {
          if (closingFence.test(lines[end])) {
            if (nonempty) {
              const newline = lines[line].endsWith('\r') ? '\r\n' : '\n';
              lines[line] = candidate[1] + newline + lines[line].slice(candidate[1].length);
              repaired = true;
            }
            break;
          }
          // Do not guess nested/literal fence boundaries or scan long logs.
          bodySize += Buffer.byteLength(lines[end], 'utf8') + 1;
          if (bodySize > 16_384 || /`{3,}|~{3,}|(?:\\`){3,}/.test(lines[end])) break;
          nonempty ||= lines[end].trim().length > 0;
        }
        if (repaired) break;
      }
    }
    if (!repaired) return output;
    // Reparse after each insertion: the old closing fence previously hid the
    // rest of the reply as an unterminated block, including later candidates.
    output = lines.join('\n');
  }
  return output;
}
