/**
 * Apple-style design tokens for the mobile app (iOS HIG translated onto the
 * graphite dark palette): semantic surfaces, SF-style type scale, radii,
 * hairlines, and shared reanimated spring configs.
 *
 * Existing screens keep `mobile-theme` exports; new/rebuilt screens should
 * consume these semantics so the whole app drifts to one language.
 */
import { StyleSheet } from 'react-native'
import { colors } from './mobile-theme'

/** iOS semantic surfaces on the graphite dark palette. */
export const appleSurfaces = {
  /** systemGroupedBackground — canvas behind grouped lists. */
  canvas: colors.bgBase,
  /** secondarySystemGroupedBackground — grouped card fill. */
  group: colors.bgPanel,
  /** tertiarySystemGroupedBackground — pressed/raised fill inside groups. */
  raised: colors.bgRaised,
  /** Hairline separator INSIDE grouped cards (inset, not edge-to-edge). */
  separator: 'rgba(255,255,255,0.09)',
  /** iOS tint for interactive text/actions. */
  tint: colors.accentBlue,
  label: colors.textPrimary,
  secondaryLabel: colors.textSecondary,
  tertiaryLabel: colors.textMuted,
  green: colors.statusGreen,
  orange: colors.statusAmber,
  red: colors.statusRed
} as const

/**
 * SF-style type scale (pt sizes at default Dynamic Type).
 * letterSpacing is in RN px units — large sizes go slightly negative.
 */
export const appleType = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, letterSpacing: -0.4 },
  title1: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.3 },
  title3: { fontSize: 20, fontWeight: '600' as const, letterSpacing: -0.2 },
  headline: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 17, fontWeight: '400' as const, letterSpacing: -0.1 },
  callout: { fontSize: 16, fontWeight: '400' as const, letterSpacing: -0.1 },
  subhead: { fontSize: 15, fontWeight: '400' as const, letterSpacing: -0.1 },
  footnote: { fontSize: 13, fontWeight: '400' as const, letterSpacing: 0 },
  caption1: { fontSize: 12, fontWeight: '400' as const, letterSpacing: 0 },
  caption2: { fontSize: 11, fontWeight: '400' as const, letterSpacing: 0.05 }
} as const

export const appleRadii = {
  /** iOS inset-grouped card corner. */
  group: 16,
  /** Standalone small card / button. */
  card: 12,
  /** Icon tile on list rows. */
  tile: 9,
  badge: 5
} as const

export const appleHairline = StyleSheet.hairlineWidth

/**
 * Reanimated spring presets ≈ iOS feel:
 * press — snappy, no overshoot (damping≈1 equivalent);
 * present — sheet/card entrances, slight settle.
 */
export const appleSprings = {
  press: { damping: 20, stiffness: 400 },
  present: { damping: 26, stiffness: 300 }
} as const
