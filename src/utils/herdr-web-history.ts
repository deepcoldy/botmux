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

function limitHistory(lines: string[], maxChars: number): { lines: string[]; removedLines: number } {
  if (!Number.isFinite(maxChars)) return { lines, removedLines: 0 };
  let chars = lines.reduce((total, line) => total + line.length, Math.max(0, lines.length - 1) * 2);
  let removedLines = 0;
  while (removedLines < lines.length - 1 && chars > maxChars) {
    chars -= lines[removedLines].length + 2;
    removedLines++;
  }
  return { lines: removedLines > 0 ? lines.slice(removedLines) : lines, removedLines };
}

function longestCommonBlock(previous: string[], next: string[]): {
  length: number;
  previousStart: number;
  nextStart: number;
} {
  const previousKeys = previous.map(lineKey);
  const nextKeys = next.map(lineKey);
  let prior = new Array<number>(next.length + 1).fill(0);
  let bestLength = 0;
  let bestPreviousEnd = 0;
  let bestNextEnd = 0;

  for (let i = 1; i <= previous.length; i++) {
    const current = new Array<number>(next.length + 1).fill(0);
    for (let j = 1; j <= next.length; j++) {
      if (previousKeys[i - 1] && previousKeys[i - 1] === nextKeys[j - 1]) {
        current[j] = prior[j - 1] + 1;
        if (current[j] > bestLength) {
          bestLength = current[j];
          bestPreviousEnd = i;
          bestNextEnd = j;
        }
      }
    }
    prior = current;
  }

  return {
    length: bestLength,
    previousStart: bestPreviousEnd - bestLength,
    nextStart: bestNextEnd - bestLength,
  };
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
    const overlap = longestCommonBlock(state.frame, frame);
    if (overlap.length >= 2 && overlap.previousStart === 0 && overlap.nextStart > 0) {
      const prefix = frame.slice(0, overlap.nextStart);
      const limited = limitHistory([...prefix, ...state.history], maxChars);
      return {
        state: { history: limited.lines, frame },
        addedLines: Math.max(0, prefix.length - limited.removedLines),
      };
    }
  }

  const limited = limitHistory(frame, maxChars);
  return { state: { history: limited.lines, frame }, addedLines: 0 };
}

export function renderHerdrWebHistory(state: HerdrWebHistoryState): string {
  return state.history.join('\r\n');
}
