export async function copyText(text: string, promptLabel?: string, anchor?: Element | null): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path for denied/unsupported async clipboard.
  }
  if (copyTextLegacy(text, anchor)) return true;
  if (promptLabel && typeof window !== 'undefined' && typeof window.prompt === 'function') {
    window.prompt(promptLabel, text);
  }
  return false;
}

function copyTextLegacy(text: string, anchor?: Element | null): boolean {
  if (
    typeof document === 'undefined'
    || !document.body
    || typeof document.createElement !== 'function'
    || typeof document.execCommand !== 'function'
  ) {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  const activeElement = typeof Element !== 'undefined' && document.activeElement instanceof Element ? document.activeElement : null;
  const host = anchor?.closest?.('dialog[open]') ?? activeElement?.closest?.('dialog[open]') ?? document.body;
  host.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
