/**
 * Shared botmux session row for mobile (full botmux screen + host-home
 * Botmux section): status dot + bot avatar + title + cli badge + meta line.
 */
import React, { useState } from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import type { BotmuxBridgeSession } from '../../botmux/botmux-bridge-rpc'
import {
  botmuxAvatarHue,
  botmuxSessionMetaLine,
  botmuxStatusTone
} from '../../botmux/botmux-session-presentation'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

const TONE_COLORS = {
  working: colors.statusAmber,
  active: colors.statusGreen,
  warning: colors.statusAmber,
  inactive: colors.textMuted
} as const

export function BotmuxStatusDot({ status }: { status?: string }): React.JSX.Element {
  const tone = botmuxStatusTone(status)
  return <View style={[styles.statusDot, { backgroundColor: TONE_COLORS[tone] }]} />
}

export function BotmuxBotAvatar({
  session,
  name,
  size = 20
}: {
  session: Pick<BotmuxBridgeSession, 'botAvatarUrl' | 'botName' | 'cliType'>
  /** Tile letter override (e.g. agent-group label); defaults to bot/cli name. */
  name?: string
  size?: number
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const displayName = name ?? session.botName?.trim() ?? session.cliType?.trim() ?? '?'
  if (session.botAvatarUrl && !failed) {
    return (
      <Image
        source={{ uri: session.botAvatarUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <View
      style={[
        styles.avatarTile,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: `hsl(${botmuxAvatarHue(displayName)}, 45%, 42%)`
        }
      ]}
    >
      <Text style={[styles.avatarLetter, { fontSize: size / 2 }]}>
        {displayName[0].toUpperCase()}
      </Text>
    </View>
  )
}

export function BotmuxSessionRow({
  session,
  busy = false,
  onOpen
}: {
  session: BotmuxBridgeSession
  busy?: boolean
  onOpen: (session: BotmuxBridgeSession) => void
}): React.JSX.Element {
  return (
    <Pressable
      // Why: Apple "kill latency" — instant press feedback on touch-down.
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onOpen(session)}
      disabled={busy}
      accessibilityRole="button"
    >
      <BotmuxStatusDot status={session.status} />
      <BotmuxBotAvatar session={session} />
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {session.title || session.sessionId.slice(0, 12)}
          </Text>
          {session.cliType ? (
            <View style={styles.cliBadge}>
              <Text style={styles.cliBadgeText}>{session.cliType}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {botmuxSessionMetaLine(session)}
        </Text>
      </View>
      {busy ? <ActivityIndicator size="small" color={colors.accentBlue} /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  avatarTile: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontWeight: '700', color: '#ffffff' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.card
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowTitle: {
    flexShrink: 1,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  cliBadge: {
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 4,
    paddingVertical: 1
  },
  cliBadgeText: { fontSize: 10, color: colors.textSecondary },
  rowMeta: { fontSize: typography.metaSize, color: colors.textSecondary, marginTop: 2 }
})
