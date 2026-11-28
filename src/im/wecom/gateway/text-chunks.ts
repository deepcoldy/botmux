export function clipWecomStream(text: string): string {
  const chars: string[] = [];
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > 20000) {
      break;
    }
    chars.push(char);
  }
  return chars.join('');
}

export function splitWecomText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    // Conservative proactive-message budget; only stream has a documented 20KB bound.
    if (bytes + size > 3000) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current || !chunks.length) {
    chunks.push(current);
  }
  return chunks.length === 1
    ? chunks
    : chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
}
