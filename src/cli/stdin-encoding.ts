export function looksLikeWindowsStdinMojibake(
  content: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;

  const trimmed = content.trim();
  if (trimmed.length < 8) return false;
  if (/[^\x00-\x7F]/.test(trimmed)) return false;

  const questionCount = (trimmed.match(/\?/g) ?? []).length;
  return questionCount >= 4 && questionCount / trimmed.length >= 0.18;
}

export function rejectLikelyWindowsStdinMojibake(content: string): void {
  if (!looksLikeWindowsStdinMojibake(content)) return;

  console.error('botmux send refused: Windows PowerShell appears to have converted non-ASCII stdin text to "?".');
  console.error('Write the message to a UTF-8 file and use: botmux send --content-file <path>');
  process.exit(2);
}

/**
 * Decode raw stdin bytes with platform-aware encoding detection.
 *
 * On Windows, PowerShell 5.1 converts an internal UTF-16LE string to the
 * active code page (e.g. CP936/GBK on Chinese systems) when piping to a
 * native executable. Reading those bytes as UTF-8 yields mojibake and
 * truncation after newlines.
 *
 * Strategy: try strict UTF-8 first. Valid UTF-8 -- the overwhelmingly common
 * case (pwsh 7, cmd with UTF-8 code page, Git Bash, and heredoc/pipe input
 * from agents) -- always decodes cleanly and is returned untouched. Only when
 * the bytes are NOT valid UTF-8 do we fall back to GBK; GBK lead/trail byte
 * pairs almost never form a valid UTF-8 sequence, so the PowerShell 5.1 case
 * lands here.
 *
 * Do NOT invert this (decode as GBK first and keep it when the result has CJK
 * chars): GBK-decoding valid UTF-8 Chinese -- and even emoji -- ALSO produces
 * CJK characters (garbage ones), so that heuristic silently corrupts every
 * valid UTF-8 message. e.g. UTF-8 "测试" would come back as "娴嬭瘯".
 */
export function decodeStdinBytes(
  raw: Buffer,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return raw.toString('utf-8');
  try {
    // fatal:true => throws on any byte sequence that isn't valid UTF-8.
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    try {
      return new TextDecoder('gbk', { fatal: false }).decode(raw);
    } catch {
      // Node built without full ICU: no GBK decoder. Best-effort UTF-8.
      return raw.toString('utf-8');
    }
  }
}
