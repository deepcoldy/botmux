import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { botAvatarHtml, loadingHtml } from './ui.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';

interface SkillRow {
  name: string;
  description?: string;
  tags?: string[];
  source?: Record<string, any>;
  rootDir?: string;
}

interface NativeSkillGroup {
  cliId: string;
  rootDir: string;
  skills: SkillRow[];
  label?: string;
}

interface BotRow {
  larkAppId: string;
  botName?: string;
  online?: boolean;
  error?: string;
  skills?: SkillPolicy | null;
}

interface SkillPolicy {
  include?: string[];
}

interface DashboardRequestError extends Error {
  status?: number;
  body?: any;
}

interface SkillJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  error?: string;
}

type StatusMessage = { text: string; ok: boolean } | null;
type DeliveryMode = 'auto' | 'prompt' | 'native';
type ProjectTrustMode = 'off' | 'all';

const INSTALLED_SKILLS_ROWS_PER_PAGE = 2;

function Html(props: { html: string; as?: 'span' | 'div' }) {
  const Tag = props.as ?? 'span';
  return <Tag style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

function nativeLibraryLabel(path: string | undefined, tr: ReturnType<typeof useT>): string | null {
  const p = String(path ?? '').replace(/\\/g, '/');
  if (p.includes('/.codex/skills/')) return tr('skills.sourceCodex');
  if (p.includes('/.claude/skills/')) return tr('skills.sourceClaude');
  if (p.includes('/.trae/skills/')) return tr('skills.sourceTrae');
  if (p.includes('/.cursor/skills/')) return tr('skills.sourceCursor');
  if (p.includes('/.gemini/skills/')) return tr('skills.sourceGemini');
  if (p.includes('/.config/opencode/skills/')) return tr('skills.sourceOpenCode');
  return null;
}

function sourceLabel(skill: SkillRow, tr: ReturnType<typeof useT>): string {
  const source = skill.source ?? {};
  if (source.type === 'github') return `github:${source.owner}/${source.repo}/${source.path ?? ''}`;
  if (source.type === 'git') return `${source.url ?? 'git'}#${source.path ?? ''}`;
  if (source.type === 'local-link') return nativeLibraryLabel(source.path, tr) ?? tr('skills.sourceLocalLink');
  if (source.type === 'local-copy') return tr('skills.sourceBotmuxCopy');
  return String(source.type ?? 'unknown');
}

function priorityNames(policy?: SkillPolicy | null): string[] {
  return (policy?.include ?? [])
    .filter(item => item.startsWith('skill:'))
    .map(item => item.slice('skill:'.length));
}

function policyReferenceCount(policy?: SkillPolicy | null): number {
  return priorityNames(policy).length;
}

function policyConfigured(policy?: SkillPolicy | null): boolean {
  return priorityNames(policy).length > 0;
}

function discoveryGroupKey(group: NativeSkillGroup): string {
  return `${group.cliId}\n${group.rootDir}`;
}

function installedSkillsColumnCount(width: number): number {
  if (width >= 1600) return 4;
  if (width <= 620) return 1;
  if (width <= 980) return 2;
  return 3;
}

async function jsonRequest(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    const err = new Error(body?.error ?? `HTTP ${r.status}`) as DashboardRequestError;
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

function statusClass(status: StatusMessage): string {
  return `oncall-status${status ? ` ${status.ok ? 'hint-ok' : 'hint-warn-inline'}` : ''}`;
}

function SkillsPage() {
  const tr = useT();
  const mountedRef = useRef(true);
  const timersRef = useRef<Set<number>>(new Set());
  const discoveryDialogRef = useRef<HTMLDialogElement | null>(null);
  const botGridRef = useRef<HTMLDivElement | null>(null);

  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [nativeSkillGroups, setNativeSkillGroups] = useState<NativeSkillGroup[]>([]);
  const [bots, setBots] = useState<BotRow[]>([]);
  const [trustProjectSkills, setTrustProjectSkills] = useState<ProjectTrustMode>('off');
  const [delivery, setDelivery] = useState<DeliveryMode>('auto');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  const [installSource, setInstallSource] = useState('');
  const [installPath, setInstallPath] = useState('');
  const [installRef, setInstallRef] = useState('');
  const [installStatus, setInstallStatus] = useState<StatusMessage>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [activeDiscoveryKey, setActiveDiscoveryKey] = useState<string | null>(null);
  const [selectedDiscovered, setSelectedDiscovered] = useState<Set<string>>(() => new Set());

  const [installedSkillsPage, setInstalledSkillsPage] = useState(0);
  const [globalBusy, setGlobalBusy] = useState<'project' | 'delivery' | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [botStatuses, setBotStatuses] = useState<Record<string, StatusMessage>>({});

  const installedNames = useMemo(() => new Set(skills.map(skill => skill.name)), [skills]);
  const installedPageSize = installedSkillsColumnCount(viewportWidth) * INSTALLED_SKILLS_ROWS_PER_PAGE;
  const installedPageCount = Math.max(1, Math.ceil(skills.length / installedPageSize));
  const visibleSkills = skills.slice(installedSkillsPage * installedPageSize, installedSkillsPage * installedPageSize + installedPageSize);
  const activeDiscoveryGroup = useMemo(() => {
    if (nativeSkillGroups.length === 0) return undefined;
    const active = activeDiscoveryKey ? nativeSkillGroups.find(group => discoveryGroupKey(group) === activeDiscoveryKey) : undefined;
    return active ?? nativeSkillGroups.find(group => group.skills.length > 0) ?? nativeSkillGroups[0];
  }, [activeDiscoveryKey, nativeSkillGroups]);
  const activeKey = activeDiscoveryGroup ? discoveryGroupKey(activeDiscoveryGroup) : '';
  const activeGroupSelectable = useMemo(() => {
    if (!activeDiscoveryGroup) return [];
    return activeDiscoveryGroup.skills
      .filter(skill => !installedNames.has(skill.name))
      .map(skill => skill.rootDir ?? skill.source?.root ?? '')
      .filter(Boolean);
  }, [activeDiscoveryGroup, installedNames]);
  const activeAllSelected = activeGroupSelectable.length > 0 && activeGroupSelectable.every(path => selectedDiscovered.has(path));

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
  }, []);

  const delay = useCallback((ms: number) => new Promise<void>(resolve => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      resolve();
    }, ms);
    timersRef.current.add(id);
  }), []);

  const fetchData = useCallback(async () => {
    const [skillsRes, botsRes] = await Promise.all([
      fetch('/api/skills'),
      fetch('/api/bots'),
    ]);
    const skillsBody = await skillsRes.json().catch(() => ({}));
    const botsBody = await botsRes.json().catch(() => ({}));
    if (!skillsRes.ok) {
      const error = skillsBody?.error ?? `skills HTTP ${skillsRes.status}`;
      throw new Error(error === 'not_found_yet' || error === 'not_found' ? tr('skills.apiUnavailable') : error);
    }
    if (!botsRes.ok) throw new Error(botsBody?.error ?? `bots HTTP ${botsRes.status}`);
    return {
      skills: Array.isArray(skillsBody.skills) ? skillsBody.skills as SkillRow[] : [],
      nativeSkillGroups: Array.isArray(skillsBody.nativeSkillGroups) ? skillsBody.nativeSkillGroups as NativeSkillGroup[] : [],
      bots: Array.isArray(botsBody.bots) ? botsBody.bots as BotRow[] : [],
      trustProjectSkills: skillsBody.trustProjectSkills === 'all' ? 'all' as const : 'off' as const,
      delivery: (skillsBody.delivery === 'prompt' || skillsBody.delivery === 'native' ? skillsBody.delivery : 'auto') as DeliveryMode,
    };
  }, [tr]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchData();
      if (!mountedRef.current) return;
      setSkills(next.skills);
      setNativeSkillGroups(next.nativeSkillGroups);
      setBots(next.bots);
      setTrustProjectSkills(next.trustProjectSkills);
      setDelivery(next.delivery);
      setLoadError(null);
      setSelectedDiscovered(selected => {
        const valid = new Set<string>();
        const installed = new Set(next.skills.map(skill => skill.name));
        for (const group of next.nativeSkillGroups) {
          for (const skill of group.skills) {
            const path = skill.rootDir ?? skill.source?.root ?? '';
            if (path && !installed.has(skill.name) && selected.has(path)) valid.add(path);
          }
        }
        return valid;
      });
    } catch (err: any) {
      if (!mountedRef.current) return;
      setLoadError(err?.message ?? String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => {
      mountedRef.current = false;
      clearTimers();
      window.removeEventListener('resize', onResize);
    };
  }, [clearTimers, refresh]);

  useEffect(() => {
    setInstalledSkillsPage(page => Math.min(Math.max(0, page), installedPageCount - 1));
  }, [installedPageCount]);

  useEffect(() => {
    const dialog = discoveryDialogRef.current;
    if (!dialog) return;
    if (discoveryOpen && !dialog.open) {
      try { dialog.showModal(); } catch { /* dialog may already be closing */ }
    } else if (!discoveryOpen && dialog.open) {
      dialog.close();
    }
  }, [discoveryOpen, activeKey]);

  async function waitForSkillJob(job: SkillJob, setStatus: (status: StatusMessage) => void, refreshOnSuccess = true): Promise<void> {
    let current = job;
    setStatus({ text: tr('skills.jobRunning'), ok: true });
    for (;;) {
      if (!mountedRef.current) return;
      if (current.status === 'succeeded') {
        setStatus({ text: tr('skills.saved'), ok: true });
        if (refreshOnSuccess) await refresh();
        return;
      }
      if (current.status === 'failed') {
        throw new Error(current.error ?? 'job_failed');
      }
      await delay(800);
      if (!mountedRef.current) return;
      const body = await jsonRequest(`/api/skills/jobs/${encodeURIComponent(current.id)}`, { method: 'GET' });
      if (!mountedRef.current) return;
      current = body.job as SkillJob;
    }
  }

  function referencingBotLabels(skillName: string): string[] {
    return bots
      .filter(bot => priorityNames(bot.skills).includes(skillName))
      .map(bot => bot.botName ?? bot.larkAppId);
  }

  async function installSkill(): Promise<void> {
    setInstallBusy(true);
    try {
      const body = await jsonRequest('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({
          source: installSource.trim(),
          path: installPath.trim() || undefined,
          ref: installRef.trim() || undefined,
        }),
      });
      if (!mountedRef.current) return;
      await waitForSkillJob(body.job as SkillJob, setInstallStatus);
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false });
    } finally {
      if (mountedRef.current) setInstallBusy(false);
    }
  }

  async function registerDiscoveredSkills(): Promise<void> {
    const selected = [...selectedDiscovered].filter(Boolean);
    if (selected.length === 0) {
      setInstallStatus({ text: tr('skills.discoverNothingSelected'), ok: false });
      return;
    }
    setDiscoveryBusy(true);
    try {
      setInstallStatus({ text: tr('skills.discoverRegisteringBatch', { total: selected.length }), ok: true });
      await jsonRequest('/api/skills/install-local-links', {
        method: 'POST',
        body: JSON.stringify({ sources: selected }),
      });
      if (!mountedRef.current) return;
      setDiscoveryOpen(false);
      await refresh();
      if (mountedRef.current) setInstallStatus({ text: tr('skills.saved'), ok: true });
    } catch (err: any) {
      if (mountedRef.current) setInstallStatus({ text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false });
    } finally {
      if (mountedRef.current) setDiscoveryBusy(false);
    }
  }

  async function updateGlobalProject(next: ProjectTrustMode): Promise<void> {
    if (trustProjectSkills === next) return;
    setGlobalBusy('project');
    try {
      const body = await jsonRequest('/api/skills/global', {
        method: 'PUT',
        body: JSON.stringify({ trustProjectSkills: next }),
      });
      if (!mountedRef.current) return;
      setTrustProjectSkills(body.trustProjectSkills === 'all' ? 'all' : next);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${err?.message ?? err}`);
    } finally {
      if (mountedRef.current) setGlobalBusy(null);
    }
  }

  async function updateGlobalDelivery(next: DeliveryMode): Promise<void> {
    if (delivery === next) return;
    setGlobalBusy('delivery');
    try {
      const body = await jsonRequest('/api/skills/global', {
        method: 'PUT',
        body: JSON.stringify({ delivery: next }),
      });
      if (!mountedRef.current) return;
      setDelivery(body.delivery === 'prompt' || body.delivery === 'native' ? body.delivery : next);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${err?.message ?? err}`);
    } finally {
      if (mountedRef.current) setGlobalBusy(null);
    }
  }

  function scrollBots(dir: -1 | 1): void {
    const grid = botGridRef.current;
    const card = grid?.querySelector<HTMLElement>('.skills-bot-card');
    if (!grid || !card) return;
    const style = window.getComputedStyle(grid);
    const gap = Number.parseFloat(style.columnGap || style.gap || '0') || 0;
    grid.scrollBy({ left: dir * (card.getBoundingClientRect().width + gap), behavior: 'smooth' });
  }

  async function updateSkill(name: string): Promise<void> {
    setSkillBusy(`${name}:update`);
    try {
      const body = await jsonRequest(`/api/skills/${encodeURIComponent(name)}/update`, { method: 'POST', body: '{}' });
      if (!mountedRef.current) return;
      await waitForSkillJob(body.job as SkillJob, setInstallStatus);
    } catch (err: any) {
      if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${err?.message ?? err}`);
    } finally {
      if (mountedRef.current) setSkillBusy(null);
    }
  }

  async function removeSkill(name: string): Promise<void> {
    if (!window.confirm(`${tr('skills.remove')} ${name}?`)) return;
    setSkillBusy(`${name}:remove`);
    try {
      await jsonRequest(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE', body: '{}' });
      if (!mountedRef.current) return;
      await refresh();
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (err?.status === 409 && err?.body?.error === 'skill_in_use') {
        const affected = Array.isArray(err.body.affectedBots)
          ? err.body.affectedBots.map((bot: any) => {
            const label = bot?.botName || bot?.larkAppId;
            return label ? `${label}` : '';
          }).filter(Boolean)
          : referencingBotLabels(name);
        const refs = [affected.length ? `Bot: ${affected.join(', ')}` : ''].filter(Boolean).join('; ') || '-';
        if (!window.confirm(tr('skills.removeInUse', { skill: name, refs }))) return;
        try {
          await jsonRequest(`/api/skills/${encodeURIComponent(name)}?force=1`, { method: 'DELETE', body: '{}' });
          if (!mountedRef.current) return;
          await refresh();
          return;
        } catch (forceErr: any) {
          if (mountedRef.current) window.alert(`${tr('skills.failed')}: ${forceErr?.message ?? forceErr}`);
          return;
        }
      }
      window.alert(`${tr('skills.failed')}: ${err?.message ?? err}`);
    } finally {
      if (mountedRef.current) setSkillBusy(null);
    }
  }

  async function updateBotSkill(appId: string, action: 'attach' | 'detach', name: string): Promise<void> {
    const busyKey = `${appId}:${action}:${name}`;
    setBotBusy(busyKey);
    setBotStatuses(statuses => ({ ...statuses, [appId]: null }));
    try {
      const body = await jsonRequest(`/api/bots/${encodeURIComponent(appId)}/skills`, {
        method: 'PUT',
        body: JSON.stringify({ action, name }),
      });
      if (!mountedRef.current) return;
      setBots(rows => rows.map(bot => bot.larkAppId === appId ? { ...bot, skills: body.skills ?? null } : bot));
    } catch (err: any) {
      if (mountedRef.current) {
        setBotStatuses(statuses => ({
          ...statuses,
          [appId]: { text: `${tr('skills.failed')}: ${err?.message ?? err}`, ok: false },
        }));
      }
    } finally {
      if (mountedRef.current) setBotBusy(null);
    }
  }

  const configuredBotCount = bots.filter(bot => policyConfigured(bot.skills)).length;
  const attachedSkillRefCount = bots.reduce((sum, bot) => sum + policyReferenceCount(bot.skills), 0);

  const body = loading
    ? <Html html={loadingHtml()} as="div" />
    : loadError
      ? <p className="hint-warn">{loadError}</p>
      : (
        <div className="skills-page-grid">
          <aside className="skills-side-rail">
            <article className="bd-card skills-defaults-panel">
              <h3 className="bd-section-title">{tr('skills.globalDefaults')}</h3>
              <div className="skills-control-block">
                <span className="skills-control-label">{tr('skills.globalProject')}</span>
                <div className="skills-choice-group skills-choice-group-compact skills-project-group">
                  {([
                    ['off', tr('skills.globalProjectOff'), tr('skills.globalProjectOffHelp')],
                    ['all', tr('skills.globalProjectAll'), tr('skills.globalProjectAllHelp')],
                  ] as const).map(([value, label, help]) => (
                    <button
                      key={value}
                      type="button"
                      className={`skills-choice${trustProjectSkills === value ? ' selected' : ''}`}
                      data-global-project-value={value}
                      aria-pressed={trustProjectSkills === value ? 'true' : 'false'}
                      disabled={globalBusy === 'project'}
                      onClick={() => void updateGlobalProject(value)}
                    >
                      <strong>{label}</strong><small>{help}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="skills-control-block">
                <span className="skills-control-label">{tr('skills.globalDelivery')}</span>
                <div className="skills-choice-group skills-delivery-group">
                  {([
                    ['auto', tr('skills.deliveryAuto'), tr('skills.deliveryAutoHelp')],
                    ['prompt', tr('skills.deliveryPrompt'), tr('skills.deliveryPromptHelp')],
                    ['native', tr('skills.deliveryNative'), tr('skills.deliveryNativeHelp')],
                  ] as const).map(([value, label, help]) => (
                    <button
                      key={value}
                      type="button"
                      className={`skills-choice${delivery === value ? ' selected' : ''}`}
                      data-global-delivery-value={value}
                      aria-pressed={delivery === value ? 'true' : 'false'}
                      disabled={globalBusy === 'delivery'}
                      onClick={() => void updateGlobalDelivery(value)}
                    >
                      <strong>{label}</strong><small>{help}</small>
                    </button>
                  ))}
                </div>
              </div>
            </article>

            <article className="bd-card skills-install-panel">
              <div className="skills-install-title">
                <h3 className="bd-section-title">{tr('skills.install')}</h3>
                <span className="skills-help-tip">
                  <button type="button" className="skills-help-button" aria-label={tr('skills.installInfoLabel')}>?</button>
                  <span className="skills-help-popover" role="tooltip">{tr('skills.installInfo')}</span>
                </span>
              </div>
              <div className="skills-install-grid">
                <div className="skills-source-label"><span>{tr('skills.source')}</span>
                  <div className="skills-source-control">
                    <input
                      type="text"
                      data-install="source"
                      aria-label={tr('skills.source')}
                      placeholder={tr('skills.sourcePlaceholder')}
                      value={installSource}
                      onChange={e => setInstallSource(e.currentTarget.value)}
                    />
                    <button type="button" data-action="discover-native-skills" onClick={() => setDiscoveryOpen(true)}>
                      {tr('skills.discover')}
                    </button>
                  </div>
                </div>
                <div className="bd-section-note skills-install-note">
                  <span><strong>{tr('skills.sourceHelpRemoteLabel')}</strong>{tr('skills.sourceHelpRemote')}</span>
                  <span><strong>{tr('skills.sourceHelpLocalLabel')}</strong>{tr('skills.sourceHelpLocal')}</span>
                </div>
                <label className="skills-install-field-wide"><span>{tr('skills.path')}</span>
                  <input
                    type="text"
                    data-install="path"
                    placeholder={tr('skills.pathPlaceholder')}
                    value={installPath}
                    onChange={e => setInstallPath(e.currentTarget.value)}
                  />
                </label>
                <label className="skills-install-field-wide"><span>{tr('skills.ref')}</span>
                  <input
                    type="text"
                    data-install="ref"
                    placeholder={tr('skills.refPlaceholder')}
                    value={installRef}
                    onChange={e => setInstallRef(e.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="actions">
                <button type="button" className="primary" data-action="install" disabled={installBusy} onClick={() => void installSkill()}>
                  {tr('skills.installSubmit')}
                </button>
                <span className={statusClass(installStatus)} data-skills-status>{installStatus?.text ?? ''}</span>
              </div>
            </article>
          </aside>

          <section className="skills-main-panel">
            <section className="skills-overview">
              <div className="skills-overview-copy">
                <h2>{tr('skills.overviewTitle')}</h2>
                <p>{tr('skills.overviewBody')}</p>
              </div>
              <div className="skills-metric-strip">
                <span><small>{tr('skills.metricInstalled')}</small><strong>{skills.length}</strong></span>
                <span><small>{tr('skills.metricBots')}</small><strong>{configuredBotCount}/{bots.length}</strong></span>
                <span><small>{tr('skills.metricAttached')}</small><strong>{attachedSkillRefCount}</strong></span>
              </div>
            </section>

            <section className="skills-bots-panel">
              <div className="skills-section-head skills-section-head-row">
                <div>
                  <h2>{tr('skills.bots')}</h2>
                  <p>{tr('skills.botsHelp')}</p>
                </div>
                {bots.length > 3 ? (
                  <div className="skills-bot-rail-actions">
                    <button type="button" className="skills-rail-button" data-action="scroll-bots" data-dir="-1" aria-label={tr('skills.scrollBotsPrev')} title={tr('skills.scrollBotsPrev')} onClick={() => scrollBots(-1)}>&lsaquo;</button>
                    <span className="skills-count-pill">{tr('skills.botCount', { count: bots.length })}</span>
                    <button type="button" className="skills-rail-button" data-action="scroll-bots" data-dir="1" aria-label={tr('skills.scrollBotsNext')} title={tr('skills.scrollBotsNext')} onClick={() => scrollBots(1)}>&rsaquo;</button>
                  </div>
                ) : <span className="skills-count-pill">{tr('skills.botCount', { count: bots.length })}</span>}
              </div>
              <div className="skills-bot-grid" ref={botGridRef}>
                {bots.map(bot => (
                  <BotPolicyCard
                    key={bot.larkAppId}
                    bot={bot}
                    installedNames={installedNames}
                    skills={skills}
                    status={botStatuses[bot.larkAppId] ?? null}
                    busyKey={botBusy}
                    onUpdate={updateBotSkill}
                  />
                ))}
              </div>
            </section>

            <section className="bd-card skills-installed-panel">
              <div className="skills-section-head skills-section-head-row">
                <div>
                  <h2>{tr('skills.installed')}</h2>
                  <p>{tr('skills.installedHelp')}</p>
                </div>
                {installedPageCount <= 1 ? (
                  <span className="skills-count-pill">{tr('skills.skillCount', { count: skills.length })}</span>
                ) : (
                  <div className="skills-installed-toolbar">
                    <span className="skills-count-pill">{tr('skills.skillCount', { count: skills.length })}</span>
                    <div className="skills-pager">
                      <button
                        type="button"
                        className="skills-pager-button"
                        data-action="page-installed-skills"
                        data-dir="-1"
                        aria-label={tr('skills.prevPage')}
                        title={tr('skills.prevPage')}
                        disabled={installedSkillsPage === 0}
                        onClick={() => setInstalledSkillsPage(page => Math.max(0, page - 1))}
                      >&lsaquo;</button>
                      <span>{tr('skills.pageStatus', { page: installedSkillsPage + 1, pages: installedPageCount })}</span>
                      <button
                        type="button"
                        className="skills-pager-button"
                        data-action="page-installed-skills"
                        data-dir="1"
                        aria-label={tr('skills.nextPage')}
                        title={tr('skills.nextPage')}
                        disabled={installedSkillsPage >= installedPageCount - 1}
                        onClick={() => setInstalledSkillsPage(page => Math.min(installedPageCount - 1, page + 1))}
                      >&rsaquo;</button>
                    </div>
                  </div>
                )}
              </div>
              {skills.length === 0 ? <p className="empty">{tr('skills.empty')}</p> : (
                <div className="skills-list">
                  {visibleSkills.map(skill => (
                    <article className="skills-row skills-installed-card" data-skill={skill.name} key={skill.name}>
                      <div className="skills-row-body">
                        <strong>{skill.name}</strong>
                        {skill.description ? <p>{skill.description}</p> : null}
                        <small className="skills-source-badge">{sourceLabel(skill, tr)}</small>
                      </div>
                      <div className="skills-card-actions">
                        <button type="button" data-action="update-skill" disabled={skillBusy === `${skill.name}:update`} onClick={() => void updateSkill(skill.name)}>
                          {tr('skills.update')}
                        </button>
                        <button type="button" data-action="remove-skill" disabled={skillBusy === `${skill.name}:remove`} onClick={() => void removeSkill(skill.name)}>
                          {tr('skills.remove')}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>

          <dialog className="skills-discovery-dialog" id="skills-discovery-dialog" ref={discoveryDialogRef} onClose={() => setDiscoveryOpen(false)}>
            <article>
              <header>
                <h3>{tr('skills.discoverTitle')}</h3>
                <p>{tr('skills.discoverHelp')}</p>
              </header>
              <div className="skills-discovery-body">
                {!activeDiscoveryGroup ? <p className="empty">{tr('skills.discoverEmpty')}</p> : (
                  <>
                    <div className="skills-discovery-tabs" role="tablist" aria-label={tr('skills.discoverTitle')}>
                      {nativeSkillGroups.map(group => {
                        const key = discoveryGroupKey(group);
                        const selected = key === activeKey;
                        return (
                          <button
                            key={key}
                            type="button"
                            role="tab"
                            data-discovery-tab={key}
                            className={selected ? 'selected' : ''}
                            aria-selected={selected ? 'true' : 'false'}
                            onClick={() => setActiveDiscoveryKey(key)}
                          >
                            <strong>{group.label ?? group.cliId}</strong>
                            <small>{tr('skills.skillCount', { count: group.skills.length })}</small>
                          </button>
                        );
                      })}
                    </div>
                    <div className="skills-discovery-path"><code>{activeDiscoveryGroup.rootDir}</code></div>
                    {nativeSkillGroups.map(group => {
                      const key = discoveryGroupKey(group);
                      const selected = key === activeKey;
                      return (
                        <section className="skills-discovery-group" data-discovery-panel={key} hidden={!selected} key={key}>
                          {group.skills.length === 0 ? <p className="empty">{tr('skills.discoverGroupEmpty')}</p> : (
                            <div className="skills-discovery-list">
                              {group.skills.map(skill => {
                                const already = installedNames.has(skill.name);
                                const path = skill.rootDir ?? skill.source?.root ?? '';
                                return (
                                  <label className={`skills-discovery-row${already ? ' installed' : ''}`} key={`${skill.name}:${path}`}>
                                    <input
                                      type="checkbox"
                                      data-discovered-skill
                                      value={path}
                                      disabled={already}
                                      checked={!already && selectedDiscovered.has(path)}
                                      onChange={e => {
                                        const checked = e.currentTarget.checked;
                                        setSelectedDiscovered(prev => {
                                          const next = new Set(prev);
                                          if (checked) next.add(path);
                                          else next.delete(path);
                                          return next;
                                        });
                                      }}
                                    />
                                    <span>
                                      <strong>{skill.name}</strong>
                                      {skill.description ? <small>{skill.description}</small> : null}
                                    </span>
                                    {already ? <em>{tr('skills.discoverRegistered')}</em> : null}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </>
                )}
              </div>
              <footer className="actions">
                <button
                  type="button"
                  data-action="toggle-discovered-skills"
                  disabled={activeGroupSelectable.length === 0}
                  onClick={() => {
                    setSelectedDiscovered(prev => {
                      const next = new Set(prev);
                      if (activeAllSelected) activeGroupSelectable.forEach(path => next.delete(path));
                      else activeGroupSelectable.forEach(path => next.add(path));
                      return next;
                    });
                  }}
                >
                  {activeAllSelected ? tr('skills.discoverClearSelection') : tr('skills.discoverSelectAll')}
                </button>
                <button type="button" className="primary" data-action="register-discovered-skills" disabled={discoveryBusy} onClick={() => void registerDiscoveredSkills()}>
                  {tr('skills.discoverRegister')}
                </button>
                <button type="button" data-action="close-discovery" onClick={() => setDiscoveryOpen(false)}>{tr('skills.discoverClose')}</button>
              </footer>
            </article>
          </dialog>
        </div>
      );

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.skills')}</p>
          <h1>{tr('skills.title')}</h1>
          <p>{tr('skills.subtitle')}</p>
        </div>
        <button type="button" id="skills-refresh" disabled={loading} onClick={() => void refresh()}>{tr('skills.refresh')}</button>
      </div>
      <div id="skills-body">{body}</div>
    </section>
  );
}

export function BotPolicyCard(props: {
  bot: BotRow;
  installedNames: Set<string>;
  skills: SkillRow[];
  status: StatusMessage;
  busyKey: string | null;
  onUpdate(appId: string, action: 'attach' | 'detach', name: string): Promise<void>;
}) {
  const tr = useT();
  const { bot, installedNames, skills, status, busyKey, onUpdate } = props;
  const label = bot.botName ?? bot.larkAppId;
  const names = priorityNames(bot.skills);
  const attached = new Set(names);
  const attachOptions = skills.filter(skill => !attached.has(skill.name));
  const [selected, setSelected] = useState(attachOptions[0]?.name ?? '');

  useEffect(() => {
    if (!selected || !attachOptions.some(skill => skill.name === selected)) {
      setSelected(attachOptions[0]?.name ?? '');
    }
  }, [attachOptions, selected]);

  if (bot.error) {
    return (
      <article className="bd-card skills-bot-card" data-appid={bot.larkAppId}>
        <header>
          <Html html={botAvatarHtml({ name: label, larkAppId: bot.larkAppId, size: 'sm' })} />
          <strong>{label}</strong>
        </header>
        <p className="hint-warn-inline">{bot.error}</p>
      </article>
    );
  }

  return (
    <article className="bd-card skills-bot-card" data-appid={bot.larkAppId}>
      <header className="skills-bot-head">
        <Html html={botAvatarHtml({ name: label, larkAppId: bot.larkAppId, size: 'sm', dot: 'ok' })} />
        <div><strong>{label}</strong><code>{bot.larkAppId}</code></div>
        <span className="skills-count-pill">{tr('skills.skillCount', { count: names.length })}</span>
      </header>
      <section className="bd-section">
        <h3 className="bd-section-title">{tr('skills.priority')}</h3>
        {names.length === 0 ? <p className="bd-section-note">{tr('skills.noPriority')}</p> : (
          <div className="skills-chip-list">
            {names.map(name => {
              const dangling = !installedNames.has(name);
              return (
                <span className={`skills-priority-row${dangling ? ' skills-priority-dangling' : ''}`} title={dangling ? tr('skills.dangling') : ''} key={name}>
                  <span className="skills-priority-name">{name}{dangling ? <small>{tr('skills.dangling')}</small> : null}</span>
                  <button
                    type="button"
                    className="skills-priority-remove"
                    data-action="detach-skill"
                    data-name={name}
                    aria-label={tr('skills.detachNamed', { skill: name })}
                    disabled={busyKey === `${bot.larkAppId}:detach:${name}`}
                    onClick={() => void onUpdate(bot.larkAppId, 'detach', name)}
                  >&times;</button>
                </span>
              );
            })}
          </div>
        )}
        <div className="actions skills-attach-row">
          {attachOptions.length === 0 ? <button type="button" disabled>{tr('skills.attach')}</button> : (
            <>
              <select data-attach-picker value={selected} onChange={e => setSelected(e.currentTarget.value)}>
                {attachOptions.map(skill => <option value={skill.name} key={skill.name}>{skill.name}</option>)}
              </select>
              <button
                type="button"
                data-action="attach-skill"
                disabled={!selected || busyKey === `${bot.larkAppId}:attach:${selected}`}
                onClick={() => selected && void onUpdate(bot.larkAppId, 'attach', selected)}
              >
                {tr('skills.attach')}
              </button>
            </>
          )}
        </div>
      </section>
      <span className={statusClass(status)} data-bot-status>{status?.text ?? ''}</span>
    </article>
  );
}

export function renderSkillsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SkillsPage />);
}
