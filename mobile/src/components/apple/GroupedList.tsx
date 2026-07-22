/**
 * iOS inset-grouped list idiom: rows live INSIDE one rounded card per section,
 * separated by inset hairlines — not floating cards with gaps and borders.
 *
 * FlatList/SectionList integration: rows carry their own position-driven
 * corners (rowStyleForGroupIndex) and the separator is a hairline inset to
 * the row's leading content edge, so a section of rows reads as one card.
 */
import React from 'react'
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { appleHairline, appleRadii, appleSurfaces, appleType } from '../../theme/apple-tokens'

/**
 * Row style for index `index` of `count` rows inside a grouped section:
 * the group card background + first/last rounded corners. Apply on the row's
 * outer container; separators come from AppleGroupSeparator.
 */
export function rowStyleForGroupIndex(index: number, count: number): ViewStyle {
  return {
    backgroundColor: appleSurfaces.group,
    borderTopLeftRadius: index === 0 ? appleRadii.group : 0,
    borderTopRightRadius: index === 0 ? appleRadii.group : 0,
    borderBottomLeftRadius: index === count - 1 ? appleRadii.group : 0,
    borderBottomRightRadius: index === count - 1 ? appleRadii.group : 0,
    overflow: 'hidden'
  }
}

/** Hairline separator between grouped rows, inset to the content edge. */
export function AppleGroupSeparator({ inset = 16 }: { inset?: number }): React.JSX.Element {
  return (
    <View style={{ backgroundColor: appleSurfaces.group }}>
      <View style={[styles.separator, { marginLeft: inset }]} />
    </View>
  )
}

/** Standalone grouped card container (non-list content, e.g. stats/form rows). */
export function AppleGroup({
  children,
  style
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  return <View style={[styles.group, style]}>{children}</View>
}

/** iOS section label — footnote, plain case, gray (never uppercase). */
export function AppleSectionHeader({
  title,
  trailing,
  style,
  titleStyle
}: {
  title: string
  trailing?: string
  style?: StyleProp<ViewStyle>
  titleStyle?: StyleProp<TextStyle>
}): React.JSX.Element {
  return (
    <View style={[styles.sectionHeader, style]}>
      <Text style={[styles.sectionTitle, titleStyle]}>{title}</Text>
      {trailing ? <Text style={styles.sectionTrailing}>{trailing}</Text> : null}
    </View>
  )
}

/** iOS section footer note (footnote, gray). */
export function AppleSectionFooter({ text }: { text: string }): React.JSX.Element {
  return <Text style={styles.sectionFooter}>{text}</Text>
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: appleSurfaces.group,
    borderRadius: appleRadii.group,
    overflow: 'hidden'
  },
  separator: {
    height: appleHairline,
    backgroundColor: appleSurfaces.separator
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6
  },
  sectionTitle: {
    ...appleType.footnote,
    color: appleSurfaces.secondaryLabel
  },
  sectionTrailing: {
    ...appleType.footnote,
    color: appleSurfaces.tertiaryLabel
  },
  sectionFooter: {
    ...appleType.footnote,
    color: appleSurfaces.tertiaryLabel,
    paddingHorizontal: 16,
    paddingTop: 6
  }
})
