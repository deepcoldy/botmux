import type React from 'react'

type GeneralSupportSectionProps = {
  hasPrecedingSections: boolean
}

/**
 * Former "Star on GitHub" / product-growth support section.
 * Removed for botmux — no UGC star/open-GitHub promo chrome.
 */
export function GeneralSupportSection({
  hasPrecedingSections: _hasPrecedingSections
}: GeneralSupportSectionProps): React.JSX.Element | null {
  return null
}
