/**
 * Botmux Feishu bridge sessions for the paired desktop host.
 * Lists bridge sessions (optionally scoped to a project worktree) and opens attach.
 */
import { useCallback, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  ScrollView
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, Radio, Terminal } from 'lucide-react-native'
import { useHostClient } from '../../../src/transport/client-context'
import {
  botmuxBridgeGetStatus,
  botmuxBridgeListSessions,
  botmuxBridgeNativeTerminalSpec,
  botmuxBridgeOpenTerminal,
  botmuxBridgeTmuxAttachSpec,
  type BotmuxBridgeSession
} from '../../../src/botmux/botmux-bridge-rpc'
import { orcaBotmuxHostIdFromExecutionHost } from '../../../src/botmux/botmux-session-worktree-match'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'

export default function BotmuxSessionsScreen(): React.JSX.Element {
  const router = useRouter()
  const params = useLocalSearchParams<{
    hostId: string
    worktreeId?: string
    worktreePath?: string
    worktreeName?: string
    connectionId?: string
    executionHostId?: string
  }>()
  const hostId = String(params.hostId ?? '')
  const worktreePath = typeof params.worktreePath === 'string' ? params.worktreePath : undefined
  const worktreeName = typeof params.worktreeName === 'string' ? params.worktreeName : undefined
  const connectionId = typeof params.connectionId === 'string' ? params.connectionId : undefined
  const executionHostId =
    typeof params.executionHostId === 'string' ? params.executionHostId : undefined

  const { client } = useHostClient(hostId)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [sessions, setSessions] = useState<BotmuxBridgeSession[]>([])
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const [scopeToWorktree, setScopeToWorktree] = useState(Boolean(worktreePath))

  const orcaBotmuxHostId = worktreePath
    ? orcaBotmuxHostIdFromExecutionHost(executionHostId, connectionId)
    : undefined

  const load = useCallback(async () => {
    if (!client) {
      setError('Not connected to desktop host')
      setLoading(false)
      return
    }
    setError(null)
    try {
      const status = await botmuxBridgeGetStatus(client)
      setStatusMessage(
        status.message ||
          (status.ok
            ? `${status.endpoints?.length ?? 0} host(s) · ${status.totalSessions ?? status.sessionCount ?? 0} session(s)`
            : 'No Botmux endpoints connected on desktop')
      )
      const scope =
        scopeToWorktree && worktreePath && orcaBotmuxHostId
          ? { worktreePath, orcaBotmuxHostId }
          : undefined
      const list = await botmuxBridgeListSessions(client, scope)
      setSessions(list.sessions ?? [])
      if (!list.ok && (list.sessions?.length ?? 0) === 0) {
        setError(list.message || 'Failed to list Botmux sessions')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSessions([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [client, orcaBotmuxHostId, scopeToWorktree, worktreePath])

  useFocusEffect(
    useCallback(() => {
      setLoading(true)
      void load()
    }, [load])
  )

  const openSession = async (session: BotmuxBridgeSession) => {
    if (!client) {
      return
    }
    setBusySessionId(session.sessionId)
    try {
      // Prefer desktop open so the paired machine attaches the session tab.
      const opened = await botmuxBridgeOpenTerminal(client, {
        sessionId: session.sessionId,
        hostId: session.hostId,
        title: session.title
      })
      const attach = await botmuxBridgeTmuxAttachSpec(client, {
        sessionId: session.sessionId,
        hostId: session.hostId
      })
      const native = await botmuxBridgeNativeTerminalSpec(client, {
        sessionId: session.sessionId,
        hostId: session.hostId
      })
      const lines: string[] = []
      if (opened && typeof opened === 'object' && 'ok' in opened) {
        lines.push(
          opened.ok
            ? 'Desktop: open/attach requested.'
            : `Desktop open: ${opened.message ?? 'failed'}`
        )
      }
      if (attach.ok) {
        lines.push(`Attach: ${attach.shellCommand}`)
      } else if (native.ok) {
        lines.push(`Relay: ${native.command} ${native.args.join(' ')}`)
      } else {
        lines.push(attach.message || native.message || 'No attach spec')
      }
      Alert.alert(session.title || session.sessionId.slice(0, 8), lines.join('\n\n'))
    } catch (e) {
      Alert.alert('Open failed', e instanceof Error ? e.message : String(e))
    } finally {
      setBusySessionId(null)
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerTitles}>
          <Text style={styles.title}>Botmux sessions</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {worktreeName || worktreePath
              ? scopeToWorktree
                ? `This worktree · ${worktreeName || worktreePath}`
                : 'All connected hosts'
              : 'Paired desktop bridge'}
          </Text>
        </View>
        <Radio size={18} color={colors.textSecondary} />
      </View>

      {worktreePath ? (
        <Pressable
          style={styles.scopeToggle}
          onPress={() => {
            setScopeToWorktree((v) => !v)
            setLoading(true)
          }}
        >
          <Text style={styles.scopeToggleText}>
            {scopeToWorktree ? 'Show all sessions' : 'This worktree only'}
          </Text>
        </Pressable>
      ) : null}

      {statusMessage ? (
        <Text style={styles.statusLine} numberOfLines={2}>
          {statusMessage}
        </Text>
      ) : null}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accentBlue} />
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => `${item.hostId}::${item.sessionId}`}
          contentContainerStyle={sessions.length === 0 ? styles.centered : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                void load()
              }}
              tintColor={colors.accentBlue}
            />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {error ||
                (scopeToWorktree
                  ? 'No Botmux sessions under this worktree. Connect the host on desktop if needed.'
                  : 'No Botmux sessions. Connect a host in Desktop → Botmux connection.')}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => void openSession(item)}
              disabled={busySessionId === item.sessionId}
            >
              <View style={styles.rowBody}>
                <Text style={styles.rowHost} numberOfLines={1}>
                  {item.hostLabel}
                </Text>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title || item.sessionId}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {[item.botName, item.status, item.cliType, item.cwd].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {busySessionId === item.sessionId ? (
                <ActivityIndicator size="small" color={colors.accentBlue} />
              ) : (
                <Terminal size={16} color={colors.textSecondary} />
              )}
            </Pressable>
          )}
        />
      )}

      {error && sessions.length > 0 ? (
        <ScrollView style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  headerTitles: { flex: 1, minWidth: 0 },
  title: { fontSize: typography.titleSize, fontWeight: '700', color: colors.textPrimary },
  subtitle: { fontSize: typography.metaSize, color: colors.textSecondary, marginTop: 2 },
  scopeToggle: {
    alignSelf: 'flex-start',
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  scopeToggleText: {
    fontSize: typography.metaSize,
    color: colors.accentBlue,
    fontWeight: '600'
  },
  statusLine: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  },
  list: { padding: spacing.md, gap: spacing.sm },
  centered: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  empty: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.sm
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowHost: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontWeight: '600'
  },
  rowTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600',
    marginTop: 2
  },
  rowMeta: { fontSize: typography.metaSize, color: colors.textSecondary, marginTop: 2 },
  errorBanner: { maxHeight: 80, padding: spacing.md },
  errorText: { fontSize: typography.metaSize, color: colors.statusRed }
})
