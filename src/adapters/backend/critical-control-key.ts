export function isCriticalInterruptKey(key: string): boolean {
  return key === 'ctrlc' || key === 'esc';
}

/**
 * Deliver an interrupt-class terminal key with one bounded retry.
 *
 * Duplicate C-c / Escape is safer than silently claiming a stopped CLI while
 * an ambiguous transport keeps it running. Other navigation keys deliberately
 * stay outside this helper and retain best-effort semantics.
 */
export async function sendCriticalControlKey(
  sendOnce: () => void | boolean,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (sendOnce() !== false) return true;
    } catch {
      // A synchronous transport failure is retryable for interrupt keys only.
    }
    if (attempt === 0) await wait(100);
  }
  return false;
}
