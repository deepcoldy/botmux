export type HerdrWebScrollDirection = 'up' | 'down' | null;

export interface HerdrWebHistoryState {
  history: string[];
  frame: string[];
}

export interface HerdrWebHistoryMerge {
  state: HerdrWebHistoryState;
  addedLines: number;
}

const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

function splitSnapshot(snapshot: string): string[] {
  const normalised = snapshot.replace(/\r?\n/g, '\n');
  const lines = normalised.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function lineKey(line: string): string {
  return line.replace(ANSI_OSC_RE, '').replace(ANSI_CSI_RE, '').trimEnd();
}

function limitHistory(
  lines: string[],
  maxChars: number,
  protectedHead = 0,
): { lines: string[]; removedLines: number } {
  if (!Number.isFinite(maxChars)) return { lines, removedLines: 0 };
  let chars = lines.reduce((total, line) => total + line.length, Math.max(0, lines.length - 1) * 2);
  let removedLines = 0;
  while (protectedHead + removedLines < lines.length - 1 && chars > maxChars) {
    chars -= lines[protectedHead + removedLines].length + 2;
    removedLines++;
  }
  if (removedLines === 0) return { lines, removedLines };
  return {
    lines: [...lines.slice(0, protectedHead), ...lines.slice(protectedHead + removedLines)],
    removedLines,
  };
}

function commonFixedEdges(previous: string[], next: string[]): { head: number; tail: number } {
  const previousKeys = previous.map(lineKey);
  const nextKeys = next.map(lineKey);
  const max = Math.min(previous.length, next.length);
  let head = 0;
  while (head < max && previousKeys[head] && previousKeys[head] === nextKeys[head]) head++;
  let tail = 0;
  while (
    tail < max - head
    && previousKeys[previous.length - 1 - tail]
    && previousKeys[previous.length - 1 - tail] === nextKeys[next.length - 1 - tail]
  ) tail++;
  return { head, tail };
}

/**
 * Find the longest prefix of the previous scrolling region inside the next
 * region. KMP keeps this linear even for 10k-line snapshots and repeated rows.
 */
function findPreviousPrefix(previous: string[], next: string[]): {
  length: number;
  nextStart: number;
} {
  const pattern = previous.map(lineKey);
  const text = next.map(lineKey);
  if (pattern.length === 0 || text.length === 0) return { length: 0, nextStart: 0 };
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let i = 1; i < pattern.length; i++) {
    let length = prefix[i - 1];
    while (length > 0 && pattern[i] !== pattern[length]) length = prefix[length - 1];
    if (pattern[i] && pattern[i] === pattern[length]) length++;
    prefix[i] = length;
  }

  let matched = 0;
  let bestLength = 0;
  let bestStart = 0;
  for (let i = 0; i < text.length; i++) {
    while (matched > 0 && text[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (text[i] && text[i] === pattern[matched]) matched++;
    const start = i - matched + 1;
    if (start > 0 && matched > bestLength) {
      bestLength = matched;
      bestStart = start;
    }
    if (matched === pattern.length) matched = prefix[matched - 1];
  }
  return { length: bestLength, nextStart: bestStart };
}

export function mergeHerdrWebSnapshot(
  state: HerdrWebHistoryState | null,
  snapshot: string,
  direction: HerdrWebScrollDirection,
  maxChars = Number.POSITIVE_INFINITY,
): HerdrWebHistoryMerge {
  const frame = splitSnapshot(snapshot);
  if (!state || state.frame.length === 0) {
    const limited = limitHistory(frame, maxChars);
    return { state: { history: limited.lines, frame }, addedLines: 0 };
  }

  if (direction === 'up') {
    const fixed = commonFixedEdges(state.frame, frame);
    const previousBody = state.frame.slice(fixed.head, state.frame.length - fixed.tail);
    const nextBody = frame.slice(fixed.head, frame.length - fixed.tail);
    const overlap = findPreviousPrefix(previousBody, nextBody);
    if (overlap.length >= 2 && overlap.nextStart > 0) {
      const revealed = nextBody.slice(0, overlap.nextStart);
      const combined = [
        ...state.history.slice(0, fixed.head),
        ...revealed,
        ...state.history.slice(fixed.head),
      ];
      const limited = limitHistory(combined, maxChars, fixed.head);
      return {
        state: { history: limited.lines, frame },
        addedLines: Math.max(0, revealed.length - Math.min(revealed.length, limited.removedLines)),
      };
    }
  }

  const limited = limitHistory(frame, maxChars);
  return { state: { history: limited.lines, frame }, addedLines: 0 };
}

export function renderHerdrWebHistory(state: HerdrWebHistoryState): string {
  return state.history.join('\r\n');
}
