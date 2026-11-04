/** Test-CLI input surface. Parse paste and Enter in wire order even when a
 * PTY combines several writes into one data callback. Self-contained so fake
 * CLI processes can embed the function without importing repository modules. */
export function createBracketedPasteCollector(onSubmit: (text: string) => void): (chunk: string) => void {
  let input = '';
  let pasted = '';
  return (chunk: string) => {
    input += chunk;
    while (true) {
      const start = input.indexOf('\x1b[200~');
      const cr = input.indexOf('\r');
      const lf = input.indexOf('\n');
      const enter = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
      if (start >= 0 && (enter < 0 || start < enter)) {
        const end = input.indexOf('\x1b[201~', start + 6);
        if (end < 0) return;
        pasted += input.slice(start + 6, end);
        input = input.slice(end + 6);
        continue;
      }
      if (enter < 0) return;
      input = input.slice(enter + 1);
      if (pasted) {
        const text = pasted;
        pasted = '';
        onSubmit(text);
      }
    }
  };
}
