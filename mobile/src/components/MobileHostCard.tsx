import { ChevronRight, Monitor } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConnectionVerdict } from '../transport/connection-health'
import { verdictDisplayLabel } from '../transport/connection-health'
import { mobileConnectionPathLabel } from '../transport/mobile-connection-path-label'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { colors } from '../theme/mobile-theme'
import { appleRadii, appleSurfaces, appleType } from '../theme/apple-tokens'
import { rowStyleForGroupIndex } from './apple/GroupedList'
import { StatusDot } from './StatusDot'

export function MobileHostCard(props: {
  host: HostProfile
  state: ConnectionState
  verdict: ConnectionVerdict
  path: MobileConnectionPath
  worktreeCounts?: { total: number; active: number }
  /** Row position inside the grouped card (drives rounded corners). */
  groupIndex: number
  groupCount: number
  onPress: () => void
  onLongPress: () => void
}) {
  const connected = props.state === 'connected'
  const isError = ['warning', 'unreachable', 'auth-failed'].includes(props.verdict.kind)
  const worktreeSummary = props.worktreeCounts
    ? `${props.worktreeCounts.total} worktree${props.worktreeCounts.total === 1 ? '' : 's'}${props.worktreeCounts.active > 0 ? ` · ${props.worktreeCounts.active} active` : ''}`
    : null
  return (
    <Pressable
      // Why: iOS grouped rows highlight on touch-down (no scale — that's for
      // standalone cards/buttons).
      style={({ pressed }) => [
        styles.row,
        rowStyleForGroupIndex(props.groupIndex, props.groupCount),
        pressed && styles.rowPressed
      ]}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={400}
    >
      <View style={styles.icon}>
        <Monitor size={19} color={connected ? appleSurfaces.tint : colors.textSecondary} />
      </View>
      <View style={styles.main}>
        <Text
          style={[styles.name, !connected && { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {props.host.name}
        </Text>
        <View style={styles.meta}>
          <StatusDot state={props.state} verdict={props.verdict} />
          <Text style={[styles.metaText, isError && { color: colors.statusRed }]} numberOfLines={1}>
            {verdictDisplayLabel(props.verdict)}
            {connected ? ` · ${mobileConnectionPathLabel(props.path)}` : ''}
          </Text>
        </View>
        {connected && worktreeSummary ? (
          <Text style={styles.worktreeMetaText} numberOfLines={1}>
            {worktreeSummary}
          </Text>
        ) : null}
        {props.verdict.kind === 'unreachable' && !props.host.relay ? (
          <Text style={styles.discoveryHint} numberOfLines={2}>
            Update desktop Botmux and sign in to connect from anywhere
          </Text>
        ) : null}
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

/** Leading inset for separators between host rows (icon edge → text edge). */
export const HOST_ROW_SEPARATOR_INSET = 12 + 40 + 14

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  rowPressed: { backgroundColor: appleSurfaces.raised },
  icon: {
    width: 40,
    height: 40,
    borderRadius: appleRadii.tile,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appleSurfaces.raised,
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0, marginRight: 8 },
  name: { ...appleType.callout, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaText: { flex: 1, ...appleType.footnote, color: colors.textSecondary },
  worktreeMetaText: {
    marginTop: 2,
    marginLeft: 24,
    ...appleType.footnote,
    color: colors.textMuted
  },
  discoveryHint: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  }
})
