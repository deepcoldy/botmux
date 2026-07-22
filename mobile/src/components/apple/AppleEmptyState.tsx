/**
 * iOS-style empty state: a quiet icon disc, headline, body, and one tinted
 * call-to-action. Used for "nothing here yet" screens/lists.
 */
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { appleRadii, appleSurfaces, appleType } from '../../theme/apple-tokens'
import { ApplePressable } from './ApplePressable'

export function AppleEmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction
}: {
  icon: React.ReactNode
  title: string
  body?: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.iconDisc}>{icon}</View>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <ApplePressable style={styles.cta} onPress={onAction} haptic="selection">
          <Text style={styles.ctaText}>{actionLabel}</Text>
        </ApplePressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
    gap: 8
  },
  iconDisc: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appleSurfaces.group,
    marginBottom: 8
  },
  title: {
    ...appleType.title3,
    color: appleSurfaces.label,
    textAlign: 'center'
  },
  body: {
    ...appleType.subhead,
    color: appleSurfaces.secondaryLabel,
    textAlign: 'center',
    lineHeight: 20
  },
  cta: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: appleRadii.card,
    backgroundColor: appleSurfaces.tint
  },
  ctaText: {
    ...appleType.subhead,
    fontWeight: '600',
    color: '#ffffff'
  }
})
