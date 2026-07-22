/**
 * Botmux Feishu bridge sessions for the paired desktop host.
 * Desktop sidebar parity: host/agent group-by toggle, agent multi-select
 * filter drawer, collapsible sections (all persisted), activity sort,
 * bot avatar + status dot + repo:branch meta on every row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  TextInput,
  Switch
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Search,
  X
} from 'lucide-react-native'
import { useHostClient } from '../../../src/transport/client-context'
import {
  botmuxBridgeGetStatus,
  botmuxBridgeListSessions,
  type BotmuxBridgeSession
} from '../../../src/botmux/botmux-bridge-rpc'
import { openBotmuxSessionOnMobile } from '../../../src/botmux/open-botmux-session-on-mobile'
import { botmuxHostIdFromExecutionHost } from '../../../src/botmux/botmux-session-worktree-match'
import {
  botmuxSessionAgentKey,
  botmuxSessionMatchesQuery,
  buildBotmuxAgentGroups,
  buildBotmuxAgentOptions,
  groupBotmuxSessionsByHost,
  isBotmuxSessionClosed
} from '../../../src/botmux/botmux-session-presentation'
import {
  DEFAULT_BOTMUX_MOBILE_VIEW_STATE,
  loadBotmuxMobileViewState,
  saveBotmuxMobileViewState,
  type BotmuxMobileGroupBy
} from '../../../src/botmux/botmux-mobile-view-state'
import { BotmuxBotAvatar, BotmuxSessionRow } from '../../../src/components/botmux/BotmuxSessionRow'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { AppleSegmentedControl } from '../../../src/components/apple/AppleSegmentedControl'
import { formatBotmuxOpenError, getBotmuxMobileCopy } from '../../../src/botmux/botmux-mobile-copy'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { appleSurfaces, appleType } from '../../../src/theme/apple-tokens'
import { useMobileI18n } from '../../../src/i18n/mobile-i18n'

type SessionSection = {
  key: string
  label: string
  avatarUrl?: string
  workingCount: number
  totalCount: number
  data: BotmuxBridgeSession[]
}

export default function BotmuxSessionsScreen(): React.JSX.Element {
  const router = useRouter()
  const { locale, t } = useMobileI18n()
  const botmuxCopy = useMemo(() => getBotmuxMobileCopy(locale), [locale])
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
  const [showClosed, setShowClosed] = useState(false)
  const [query, setQuery] = useState('')
  /** Agent multi-select (botmuxAgentLabel keys); empty = all agents. */
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupBy, setGroupBy] = useState<BotmuxMobileGroupBy>(
    DEFAULT_BOTMUX_MOBILE_VIEW_STATE.groupBy
  )
  const [collapsedSections, setCollapsedSections] = useState<string[]>([])
  const [viewStateLoaded, setViewStateLoaded] = useState(false)
  /** Transient open-confirmation (replaces the old spec-dump Alert). */
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let active = true
    void loadBotmuxMobileViewState().then((state) => {
      if (!active) return
      setGroupBy(state.groupBy)
      setCollapsedSections(state.collapsed)
      setViewStateLoaded(true)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!viewStateLoaded) return
    void saveBotmuxMobileViewState({ groupBy, collapsed: collapsedSections })
  }, [viewStateLoaded, groupBy, collapsedSections])

  const botmuxHostId = worktreePath
    ? botmuxHostIdFromExecutionHost(executionHostId, connectionId)
    : undefined

  const load = useCallback(async () => {
    if (!client) {
      setError(t('Not connected to desktop host'))
      setLoading(false)
      return
    }
    setError(null)
    try {
      const status = await botmuxBridgeGetStatus(client)
      setStatusMessage(
        status.message ||
          (status.ok
            ? t('{{hosts}} host(s) · {{sessions}} session(s)', {
                hosts: status.endpoints?.length ?? 0,
                sessions: status.totalSessions ?? status.sessionCount ?? 0
              })
            : t('No Botmux endpoints connected on desktop'))
      )
      const scope =
        scopeToWorktree && worktreePath && botmuxHostId ? { worktreePath, botmuxHostId } : undefined
      const list = await botmuxBridgeListSessions(client, scope)
      setSessions(list.sessions ?? [])
      if (!list.ok && (list.sessions?.length ?? 0) === 0) {
        setError(list.message || t('Failed to list Botmux sessions'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSessions([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [client, botmuxHostId, scopeToWorktree, t, worktreePath])

  useFocusEffect(
    useCallback(() => {
      setLoading(true)
      void load()
    }, [load])
  )

  const openSession = async (session: BotmuxBridgeSession) => {
    if (!client || !hostId) return
    setBusySessionId(session.sessionId)
    try {
      // Why: open on the phone (create attach terminal + navigate). Desktop-only
      // openTerminal left the simulator with no UI change.
      const opened = await openBotmuxSessionOnMobile({
        client,
        mobileHostId: hostId,
        session,
        preferredWorktreeId: typeof params.worktreeId === 'string' ? params.worktreeId : undefined
      })
      if (!opened.ok) {
        Alert.alert(
          botmuxCopy.openFailedTitle,
          formatBotmuxOpenError(opened.message, locale) || botmuxCopy.openFailedFallback
        )
        return
      }
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      setStatusMessage(botmuxCopy.openedOnMobile(opened.displayName))
      router.push(opened.sessionPath as never)
    } catch (e) {
      Alert.alert(
        botmuxCopy.openFailedTitle,
        formatBotmuxOpenError(e instanceof Error ? e.message : String(e), locale)
      )
    } finally {
      setBusySessionId(null)
    }
  }

  const closedCount = useMemo(
    () => sessions.filter((s) => isBotmuxSessionClosed(s.status)).length,
    [sessions]
  )
  const openSessions = useMemo(
    () => (showClosed ? sessions : sessions.filter((s) => !isBotmuxSessionClosed(s.status))),
    [sessions, showClosed]
  )
  const agentOptions = useMemo(() => buildBotmuxAgentOptions(openSessions), [openSessions])
  const agentFiltering = selectedAgents.length > 0
  const visibleSessions = useMemo(() => {
    let list = openSessions
    if (agentFiltering) {
      const wanted = new Set(selectedAgents)
      list = list.filter((s) => wanted.has(botmuxSessionAgentKey(s)))
    }
    if (query.trim()) list = list.filter((s) => botmuxSessionMatchesQuery(s, query))
    return list
  }, [openSessions, agentFiltering, selectedAgents, query])
  const activeFilterCount = (query.trim() ? 1 : 0) + (showClosed ? 1 : 0) + selectedAgents.length

  const collapsedSet = useMemo(() => new Set(collapsedSections), [collapsedSections])
  const sections = useMemo<SessionSection[]>(() => {
    const groups =
      groupBy === 'agent'
        ? buildBotmuxAgentGroups(visibleSessions).map((g) => ({
            key: `agent:${g.agentKey}`,
            label: g.label,
            avatarUrl: g.avatarUrl,
            workingCount: g.sessions.filter(
              (s) => s.status === 'working' || s.status === 'starting'
            ).length,
            totalCount: g.sessions.length,
            sessions: g.sessions
          }))
        : groupBotmuxSessionsByHost(visibleSessions).map((g) => ({
            key: `host:${g.hostId}`,
            label: g.hostLabel,
            avatarUrl: undefined,
            workingCount: g.workingCount,
            totalCount: g.sessions.length,
            sessions: g.sessions
          }))
    // Collapsed sections keep their header but render no rows (desktop parity:
    // chevron toggles; collapse persists across launches).
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      avatarUrl: g.avatarUrl,
      workingCount: g.workingCount,
      totalCount: g.totalCount,
      data: collapsedSet.has(g.key) ? [] : g.sessions
    }))
  }, [groupBy, visibleSessions, collapsedSet])

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((list) =>
      list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
    )
  }, [])

  const toggleAgent = useCallback((agentKey: string) => {
    setSelectedAgents((list) =>
      list.includes(agentKey) ? list.filter((k) => k !== agentKey) : [...list, agentKey]
    )
  }, [])

  const resetFilters = useCallback(() => {
    setQuery('')
    setSelectedAgents([])
    setShowClosed(false)
  }, [])

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={botmuxCopy.back}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerTitles}>
          <Text style={styles.title}>{botmuxCopy.title}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {worktreeName || worktreePath
              ? scopeToWorktree
                ? botmuxCopy.subtitleWorktree(worktreeName || worktreePath || '')
                : botmuxCopy.subtitleAllHosts
              : botmuxCopy.subtitlePaired}
          </Text>
        </View>
        <Pressable
          onPress={() => setFilterOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={botmuxCopy.filterTitle}
          style={styles.filterButton}
        >
          <ListFilter size={17} color={colors.textSecondary} />
          {activeFilterCount > 0 ? (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <Search size={14} color={colors.textMuted} style={styles.searchIcon} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={botmuxCopy.filterPlaceholder}
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {query.length > 0 ? (
          <Pressable
            onPress={() => setQuery('')}
            hitSlop={8}
            accessibilityLabel={botmuxCopy.clearFilter}
          >
            <X size={14} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.segmentedRow}>
        <AppleSegmentedControl
          options={[
            { value: 'host', label: botmuxCopy.groupByHosts },
            { value: 'agent', label: botmuxCopy.groupByAgents }
          ]}
          value={groupBy}
          onChange={(v) => setGroupBy(v)}
          accessibilityLabel={botmuxCopy.filterTitle}
        />
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
            {scopeToWorktree ? botmuxCopy.showAll : botmuxCopy.thisWorktreeOnly}
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
        <SectionList
          sections={sections}
          keyExtractor={(item) => `${item.hostId}::${item.sessionId}`}
          stickySectionHeadersEnabled={false}
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
          renderSectionHeader={({ section }) => {
            const collapsed = collapsedSet.has(section.key)
            return (
              <Pressable
                style={styles.hostHeader}
                onPress={() => toggleSection(section.key)}
                accessibilityRole="button"
                accessibilityState={{ expanded: !collapsed }}
              >
                {collapsed ? (
                  <ChevronRight size={12} color={colors.textMuted} />
                ) : (
                  <ChevronDown size={12} color={colors.textMuted} />
                )}
                {section.avatarUrl ? (
                  <BotmuxBotAvatar
                    session={{ botAvatarUrl: section.avatarUrl }}
                    name={section.label}
                    size={16}
                  />
                ) : null}
                <Text style={styles.hostLabel} numberOfLines={1}>
                  {section.label}
                </Text>
                <Text style={styles.hostCount}>
                  {section.workingCount > 0 ? botmuxCopy.workingCount(section.workingCount) : ''}
                  {section.totalCount}
                </Text>
              </Pressable>
            )
          }}
          renderItem={({ item }) => (
            <BotmuxSessionRow
              session={item}
              busy={busySessionId === item.sessionId}
              onOpen={(s) => void openSession(s)}
            />
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {error ||
                (query.trim() || agentFiltering
                  ? botmuxCopy.emptyQuery(query.trim() || selectedAgents.join(', '))
                  : scopeToWorktree
                    ? botmuxCopy.emptyWorktree
                    : botmuxCopy.emptyAll)}
            </Text>
          }
        />
      )}

      {error && sessions.length > 0 ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Agent multi-select + show-closed — desktop filter-menu parity. */}
      <BottomDrawer visible={filterOpen} onClose={() => setFilterOpen(false)}>
        <View style={styles.drawer}>
          <Text style={styles.drawerTitle}>{botmuxCopy.filterTitle}</Text>

          {agentOptions.length >= 2 ? (
            <>
              <Text style={styles.drawerSectionLabel}>{botmuxCopy.groupByAgents}</Text>
              {agentOptions.map((agent) => {
                const selected = selectedAgents.includes(agent.key)
                return (
                  <Pressable
                    key={agent.key}
                    style={({ pressed }) => [styles.drawerRow, pressed && styles.drawerRowPressed]}
                    onPress={() => toggleAgent(agent.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <BotmuxBotAvatar
                      session={{ botAvatarUrl: agent.avatarUrl }}
                      name={agent.label}
                      size={20}
                    />
                    <Text style={styles.drawerRowLabel} numberOfLines={1}>
                      {agent.label}
                    </Text>
                    <Text style={styles.drawerRowCount}>{agent.count}</Text>
                    {selected ? <Check size={16} color={appleSurfaces.tint} /> : null}
                  </Pressable>
                )
              })}
            </>
          ) : null}

          <View style={styles.drawerSwitchRow}>
            <Text style={styles.drawerRowLabel}>
              {botmuxCopy.filterShowClosed}
              {closedCount > 0 ? ` (${closedCount})` : ''}
            </Text>
            <Switch
              value={showClosed}
              onValueChange={setShowClosed}
              trackColor={{ false: colors.bgRaised, true: appleSurfaces.tint }}
              thumbColor="#ffffff"
            />
          </View>

          {activeFilterCount > 0 ? (
            <Pressable
              style={styles.drawerReset}
              onPress={() => {
                resetFilters()
                setFilterOpen(false)
              }}
              accessibilityRole="button"
            >
              <Text style={styles.drawerResetText}>{botmuxCopy.resetFilters}</Text>
            </Pressable>
          ) : null}
        </View>
      </BottomDrawer>
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
    paddingVertical: spacing.sm
  },
  headerTitles: { flex: 1, minWidth: 0 },
  title: { fontSize: typography.titleSize, fontWeight: '700', color: colors.textPrimary },
  subtitle: { fontSize: typography.metaSize, color: colors.textSecondary, marginTop: 2 },
  filterButton: {
    padding: 6,
    borderRadius: 12,
    position: 'relative'
  },
  filterBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appleSurfaces.tint,
    paddingHorizontal: 3
  },
  filterBadgeText: { fontSize: 9, fontWeight: '700', color: '#ffffff' },
  segmentedRow: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.input,
    backgroundColor: colors.bgPanel
  },
  searchIcon: { marginLeft: 2 },
  searchInput: {
    flex: 1,
    paddingVertical: 7,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
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
  list: { padding: spacing.md },
  centered: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  empty: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center'
  },
  hostHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  hostLabel: { fontSize: typography.metaSize, fontWeight: '700', color: colors.textSecondary },
  hostCount: { fontSize: typography.metaSize, color: colors.textMuted },
  drawer: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    gap: 2
  },
  drawerTitle: {
    ...appleType.footnote,
    color: appleSurfaces.secondaryLabel,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  drawerSectionLabel: {
    ...appleType.caption1,
    color: appleSurfaces.tertiaryLabel,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 10
  },
  drawerRowPressed: { backgroundColor: appleSurfaces.raised },
  drawerRowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  drawerRowCount: { fontSize: typography.metaSize, color: colors.textMuted },
  drawerSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.xs
  },
  drawerReset: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs
  },
  drawerResetText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: appleSurfaces.tint
  },
  errorBanner: { maxHeight: 80, padding: spacing.md },
  errorText: { fontSize: typography.metaSize, color: colors.statusRed }
})
