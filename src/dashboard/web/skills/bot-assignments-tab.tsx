import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useT } from '../react-hooks.js';
import { SectionHeader } from '../dashboard-components.js';
import { buildSkillGraph, packIds, priorityNames, type BotGraphInfo } from './shared.js';
import type { BotRow, SkillRow, StatusMessage } from './types.js';

interface BotAssignmentsTabProps {
  bots: BotRow[];
  skills: SkillRow[];
  statuses: Record<string, StatusMessage>;
  onSave: (appId: string, names: string[], packIds: string[]) => Promise<void>;
  onMutate?: (
    appId: string,
    selector: `skill:${string}` | `pack:${string}`,
    present: boolean,
  ) => Promise<void>;
  busyBotIds?: ReadonlySet<string>;
  packs: Array<{ id: string; name: string; include: string[] }>;
  /** false = pack data never loaded; pack-derived health reads "unknown" */
  packsKnown?: boolean;
  /** cross-tab arrival: highlight these bots' rows */
  focusBotIds?: string[] | null;
  /** cross-tab arrival: prefill palette search + highlight bots resolving this skill */
  focusSkill?: string | null;
  onFocusConsumed?: () => void;
  /** chip click-throughs */
  onOpenPack?: (packId: string) => void;
  onOpenSkill?: (name: string) => void;
}

type DragItem = {
  type: 'skill' | 'pack';
  id: string;
  /** Present only when dragging an existing assignment out of a Bot row. */
  sourceBotId?: string;
};

type DuplicateDrop = {
  botId: string;
  itemLabel: string;
};

export function BotAssignmentsTab(props: BotAssignmentsTabProps) {
  const tr = useT();
  const [editingBot, setEditingBot] = useState<BotRow | null>(null);
  const [dragOverBot, setDragOverBot] = useState<string | null>(null);
  const [dragOverRemove, setDragOverRemove] = useState(false);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [duplicateDrop, setDuplicateDrop] = useState<DuplicateDrop | null>(null);
  const [skillQuery, setSkillQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [highlightBots, setHighlightBots] = useState<Set<string>>(() => new Set());
  const [highlightSkill, setHighlightSkill] = useState<string | null>(null);

  // Cross-tab arrival: apply focus context once, then consume the intent so it
  // doesn't re-apply on later visits. Highlights live in local state.
  const { focusBotIds, focusSkill, onFocusConsumed } = props;
  useEffect(() => {
    if ((focusBotIds?.length ?? 0) === 0 && !focusSkill) return;
    if (focusBotIds && focusBotIds.length > 0) setHighlightBots(new Set(focusBotIds));
    if (focusSkill) {
      setHighlightSkill(focusSkill);
      setSkillQuery(focusSkill);
    }
    onFocusConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBotIds, focusSkill]);

  useEffect(() => {
    if (!duplicateDrop) return;
    const timer = setTimeout(() => setDuplicateDrop(null), 1600);
    return () => clearTimeout(timer);
  }, [duplicateDrop]);

  // Single relationship model: per-bot resolution, counts and health all come
  // from the same graph the other skill tables use.
  const graph = useMemo(
    () => buildSkillGraph(props.skills, props.packs, props.bots, { packsKnown: props.packsKnown !== false }),
    [props.skills, props.packs, props.bots, props.packsKnown],
  );

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const skill of props.skills) {
      for (const tag of skill.tags ?? []) tags.add(tag);
    }
    return [...tags].sort();
  }, [props.skills]);

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return props.skills.filter(skill => {
      if (activeTag && !(skill.tags ?? []).includes(activeTag)) return false;
      if (!q) return true;
      return `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(q);
    });
  }, [props.skills, skillQuery, activeTag]);

  const handleDrop = async (bot: BotRow) => {
    // Existing assignments use the explicit remove zone. Do not silently turn
    // a drag between Bot rows into copy/move semantics the UI never promises.
    if (!dragItem || dragItem.sourceBotId) return;
    setDragOverBot(null);
    setDragItem(null);
    const currentSkills = priorityNames(bot.skills);
    const currentPacks = packIds(bot.skills);
    if (dragItem.type === 'skill') {
      if (currentSkills.includes(dragItem.id)) {
        setDuplicateDrop({ botId: bot.larkAppId, itemLabel: dragItem.id });
        return;
      }
      if (props.onMutate) {
        await props.onMutate(bot.larkAppId, `skill:${dragItem.id}`, true);
      } else {
        await props.onSave(bot.larkAppId, [...currentSkills, dragItem.id], currentPacks);
      }
    } else {
      if (currentPacks.includes(dragItem.id)) {
        setDuplicateDrop({
          botId: bot.larkAppId,
          itemLabel: props.packs.find(pack => pack.id === dragItem.id)?.name ?? dragItem.id,
        });
        return;
      }
      if (props.onMutate) {
        await props.onMutate(bot.larkAppId, `pack:${dragItem.id}`, true);
      } else {
        await props.onSave(bot.larkAppId, currentSkills, [...currentPacks, dragItem.id]);
      }
    }
  };

  const handleUnassign = async () => {
    const item = dragItem;
    if (!item?.sourceBotId) return;
    setDragOverRemove(false);
    setDragOverBot(null);
    setDragItem(null);
    const sourceBot = props.bots.find(bot => bot.larkAppId === item.sourceBotId);
    if (!sourceBot) return;
    const currentSkills = priorityNames(sourceBot.skills);
    const currentPacks = packIds(sourceBot.skills);
    if (item.type === 'skill') {
      if (!currentSkills.includes(item.id)) return;
      if (props.onMutate) {
        await props.onMutate(sourceBot.larkAppId, `skill:${item.id}`, false);
      } else {
        await props.onSave(
          sourceBot.larkAppId,
          currentSkills.filter(name => name !== item.id),
          currentPacks,
        );
      }
    } else {
      if (!currentPacks.includes(item.id)) return;
      if (props.onMutate) {
        await props.onMutate(sourceBot.larkAppId, `pack:${item.id}`, false);
      } else {
        await props.onSave(
          sourceBot.larkAppId,
          currentSkills,
          currentPacks.filter(id => id !== item.id),
        );
      }
    }
  };

  const clearDragState = () => {
    setDragItem(null);
    setDragOverBot(null);
    setDragOverRemove(false);
  };

  const startDrag = (event: DragEvent<HTMLElement>, item: DragItem, effect: 'copy' | 'move') => {
    event.dataTransfer.effectAllowed = effect;
    // Firefox requires drag data before it will start a native HTML drag.
    event.dataTransfer.setData('text/plain', item.id);
    setDuplicateDrop(null);
    setDragItem(item);
  };

  const draggedFromBot = dragItem?.sourceBotId
    ? props.bots.find(bot => bot.larkAppId === dragItem.sourceBotId)
    : null;

  return (
    <section className="skills-config-block">
      <SectionHeader
        title={tr('skills.bots')}
        count={tr('skills.botCount', { count: props.bots.length })}
        hint={tr('skills.botsHelp')}
      />
      <div className="skills-bot-assign-layout">
        <div className="skills-bot-palette">
          <div className="skills-bot-palette-hint">
            <span className="skills-drag-icon">⤧</span>
            <span>{tr('skills.dragHint')}</span>
          </div>
          {dragItem?.sourceBotId ? (
            <div
              className={`skills-unassign-dropzone${dragOverRemove ? ' is-active' : ''}`}
              data-action="unassign-dropzone"
              data-drag-over={dragOverRemove || undefined}
              role="status"
              aria-live="polite"
              onDragOver={event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverRemove(true);
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOverRemove(false);
              }}
              onDrop={event => {
                event.preventDefault();
                void handleUnassign().catch(() => undefined);
              }}
            >
              <span className="skills-unassign-icon" aria-hidden="true">↩</span>
              <span>
                <strong>{tr('skills.unassignDropTitle')}</strong>
                <small>{tr('skills.unassignDropHint', {
                  bot: draggedFromBot?.botName ?? dragItem.sourceBotId,
                })}</small>
              </span>
            </div>
          ) : null}
          {props.packs.length > 0 && (
            <div className="skills-bot-palette-group">
              <span className="skills-bot-palette-label">{tr('skills.packChips')}</span>
              <div className="skills-bot-palette-items">
                {props.packs.map(pack => (
                  <span
                    key={pack.id}
                    className="skills-draggable-chip skills-pack-chip"
                    draggable
                    data-palette-drag-type="pack"
                    data-palette-drag-id={pack.id}
                    onDragStart={event => startDrag(event, { type: 'pack', id: pack.id }, 'copy')}
                    onDragEnd={clearDragState}
                    title={`${pack.name} (${tr('skills.skillCount', { count: pack.include.length })})`}
                  >
                    {pack.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="skills-bot-palette-group">
            <span className="skills-bot-palette-label">{tr('skills.individualSkills')}</span>
            <input
              className="skills-bot-palette-search"
              type="text"
              placeholder={tr('skills.searchPlaceholder')}
              value={skillQuery}
              onChange={e => setSkillQuery(e.target.value)}
            />
            {allTags.length > 0 && (
              <div className="skills-bot-palette-tags">
                <button
                  className={`skills-tag-filter${activeTag === null ? ' active' : ''}`}
                  onClick={() => setActiveTag(null)}
                >
                  {tr('skills.all')}
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    className={`skills-tag-filter${activeTag === tag ? ' active' : ''}`}
                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <div className="skills-bot-palette-items">
              {filteredSkills.map(skill => (
                <span
                  key={skill.name}
                  className="skills-draggable-chip skills-skill-chip"
                  draggable
                  data-palette-drag-type="skill"
                  data-palette-drag-id={skill.name}
                  onDragStart={event => startDrag(event, { type: 'skill', id: skill.name }, 'copy')}
                  onDragEnd={clearDragState}
                  title={skill.description ?? skill.name}
                >
                  {skill.name}
                </span>
              ))}
              {filteredSkills.length === 0 && (
                <span className="muted">{tr('skills.noResults')}</span>
              )}
            </div>
          </div>
        </div>

        <article className="bd-card skills-config-card skills-bot-table-wrap">
          <div className="skills-bot-table">
            <table>
              <thead>
                <tr>
                  <th>{tr('skills.bot')}</th>
                  <th>{tr('skills.packChips')}</th>
                  <th>{tr('skills.individualSkills')}</th>
                  <th>{tr('skills.finalCount')}</th>
                  <th>{tr('skills.health')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {props.bots.map(bot => {
                  const skillNames = priorityNames(bot.skills);
                  const packNames = packIds(bot.skills);
                  const botInfo = graph.bots.get(bot.larkAppId);
                  const finalCount = botInfo?.finalCount ?? 0;
                  const health = botHealthLabel(botInfo, tr);
                  const isDragOver = dragOverBot === bot.larkAppId;
                  const isFocused = highlightBots.has(bot.larkAppId)
                    || (highlightSkill != null && (botInfo?.resolved.some(entry => entry.name === highlightSkill) ?? false));
                  const duplicateNotice = duplicateDrop?.botId === bot.larkAppId ? duplicateDrop : null;
                  const status = props.statuses[bot.larkAppId] ?? null;
                  const busy = props.busyBotIds?.has(bot.larkAppId) === true;
                  return (
                    <tr
                      key={bot.larkAppId}
                      className={`skills-bot-row${isDragOver ? ' drag-over' : ''}${isFocused ? ' skills-bot-row-focus' : ''}${busy ? ' is-busy' : ''}`}
                      aria-busy={busy}
                      onDragOver={e => {
                        if (busy || !dragItem || dragItem.sourceBotId) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        setDragOverBot(bot.larkAppId);
                      }}
                      onDragLeave={event => {
                        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                        setDragOverBot(prev => prev === bot.larkAppId ? null : prev);
                      }}
                      onDrop={e => {
                        if (busy || !dragItem || dragItem.sourceBotId) return;
                        e.preventDefault();
                        void handleDrop(bot).catch(() => undefined);
                      }}
                    >
                      <td>{bot.botName ?? bot.larkAppId}</td>
                      <td>
                        <div className="skills-pack-chips">
                          {packNames.length === 0 ? <span className="muted">—</span> :
                            packNames.map(pid => {
                              const pack = props.packs.find(p => p.id === pid);
                              // Unknown ≠ missing: without loaded pack data an
                              // unresolvable ref renders neutral, not broken.
                              const unknown = !pack && props.packsKnown === false;
                              const missing = !pack && !unknown;
                              return (
                                <span
                                  key={pid}
                                  className={`skills-assigned-draggable${dragItem?.sourceBotId === bot.larkAppId && dragItem.type === 'pack' && dragItem.id === pid ? ' is-dragging' : ''}`}
                                  draggable={!busy}
                                  data-assigned-drag-type="pack"
                                  data-assigned-drag-id={pid}
                                  data-assigned-bot={bot.larkAppId}
                                  title={tr('skills.dragToRemove')}
                                  onDragStart={event => {
                                    if (!busy) startDrag(
                                      event,
                                      { type: 'pack', id: pid, sourceBotId: bot.larkAppId },
                                      'move',
                                    );
                                  }}
                                  onDragEnd={clearDragState}
                                >
                                  <button
                                    type="button"
                                    className={`skills-pack-chip${missing ? ' skills-chip-missing' : ''}${unknown ? ' skills-chip-unknown' : ''}`}
                                    data-action="open-bot-pack"
                                    title={unknown ? tr('skills.healthUnknown') : undefined}
                                    disabled={!pack || !props.onOpenPack}
                                    onClick={() => props.onOpenPack?.(pid)}
                                  >{pack?.name ?? pid}</button>
                                </span>
                              );
                            })}
                        </div>
                      </td>
                      <td>
                        {skillNames.length === 0 ? <span className="muted">—</span> :
                          <span className="skills-skill-chips">
                            {skillNames.slice(0, 3).map(n => (
                              <span
                                key={n}
                                className={`skills-assigned-draggable${dragItem?.sourceBotId === bot.larkAppId && dragItem.type === 'skill' && dragItem.id === n ? ' is-dragging' : ''}`}
                                draggable={!busy}
                                data-assigned-drag-type="skill"
                                data-assigned-drag-id={n}
                                data-assigned-bot={bot.larkAppId}
                                title={tr('skills.dragToRemove')}
                                onDragStart={event => {
                                  if (!busy) startDrag(
                                    event,
                                    { type: 'skill', id: n, sourceBotId: bot.larkAppId },
                                    'move',
                                  );
                                }}
                                onDragEnd={clearDragState}
                              >
                                <button
                                  type="button"
                                  className="skills-skill-chip"
                                  data-action="open-bot-skill"
                                  disabled={!props.onOpenSkill}
                                  onClick={() => props.onOpenSkill?.(n)}
                                >{n}</button>
                              </span>
                            ))}
                            {skillNames.length > 3 && <span className="muted">+{skillNames.length - 3}</span>}
                          </span>}
                      </td>
                      <td>{botInfo?.health === 'unknown'
                        ? <span className="muted" title={tr('skills.healthUnknown')}>—</span>
                        : finalCount}</td>
                      <td>
                        <span className={`skills-health skills-health-${health.level}`}>
                          {health.label}
                        </span>
                      </td>
                      <td>
                        <div className="skills-bot-row-actions">
                          {duplicateNotice ? (
                            <span className="skills-duplicate-feedback" role="status" aria-live="polite">
                              {tr('skills.alreadyAssigned', { item: duplicateNotice.itemLabel })}
                            </span>
                          ) : null}
                          {status ? (
                            <span
                              className={`oncall-status ${status.ok ? 'hint-ok' : 'hint-warn-inline'}`}
                              role="status"
                              aria-live="polite"
                            >{status.text}</span>
                          ) : busy ? (
                            <span className="oncall-status" role="status" aria-live="polite">{tr('skills.saving')}</span>
                          ) : null}
                          <button className="bd-button" disabled={busy} onClick={() => setEditingBot(bot)}>
                            {tr('skills.select')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      </div>
      {editingBot && (
        <BotAssignmentEditor
          bot={editingBot}
          skills={props.skills}
          packs={props.packs}
          status={props.statuses[editingBot.larkAppId] ?? null}
          onClose={() => setEditingBot(null)}
          onSave={(names, ids) => props.onSave(editingBot.larkAppId, names, ids)}
        />
      )}
    </section>
  );
}

/** Map graph health to a display level + translated label. */
function botHealthLabel(info: BotGraphInfo | undefined, tr: ReturnType<typeof useT>): { level: 'ok' | 'warn' | 'error' | 'unknown'; label: string } {
  switch (info?.health) {
    case 'pack_missing': return { level: 'error', label: tr('skills.healthPackMissing') };
    case 'missing': return { level: 'warn', label: tr('skills.healthMissing', { count: info.missingSkills.length }) };
    case 'unknown': return { level: 'unknown', label: tr('skills.healthUnknown') };
    case 'default': case undefined: return { level: 'ok', label: tr('skills.healthDefault') };
    default: return { level: 'ok', label: tr('skills.healthOk') };
  }
}

function BotAssignmentEditor(props: {
  bot: BotRow;
  skills: SkillRow[];
  packs: Array<{ id: string; name: string; include: string[] }>;
  status: StatusMessage;
  onClose: () => void;
  onSave: (names: string[], packIds: string[]) => Promise<void>;
}) {
  const tr = useT();
  const currentSkills = useMemo(() => priorityNames(props.bot.skills), [props.bot.skills]);
  const currentPacks = useMemo(() => packIds(props.bot.skills), [props.bot.skills]);
  const [skillDraft, setSkillDraft] = useState<Set<string>>(() => new Set(currentSkills));
  const [packDraft, setPackDraft] = useState<Set<string>>(() => new Set(currentPacks));
  const [busy, setBusy] = useState(false);

  const toggleSkill = (name: string) => {
    setSkillDraft(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  };
  const togglePack = (id: string) => {
    setPackDraft(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const resolvedPreview = useMemo(() => {
    const seen = new Map<string, string>(); // name -> source
    for (const name of skillDraft) seen.set(name, 'direct');
    for (const id of packDraft) {
      const pack = props.packs.find(p => p.id === id);
      if (pack) for (const inc of pack.include) {
        const n = inc.replace('skill:', '');
        if (!seen.has(n)) seen.set(n, `pack:${pack.name}`);
      }
    }
    return [...seen.entries()].map(([name, source]) => ({ name, source }));
  }, [skillDraft, packDraft, props.packs]);

  const save = async () => {
    setBusy(true);
    try {
      await props.onSave([...skillDraft], [...packDraft]);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="bd-dialog skills-bot-editor" open onClose={props.onClose}>
      <form method="dialog" data-action="save-bot-assignment" onSubmit={e => {
        e.preventDefault();
        void save().catch(() => undefined);
      }}>
        <h3>{tr('skills.botEdit')}: {props.bot.botName ?? props.bot.larkAppId}</h3>
        {props.status && <p className={`hint-${props.status.ok ? 'ok' : 'warn'}`}>{props.status.text}</p>}

        <div className="skills-control-block">
          <label>{tr('skills.packChips')}</label>
          <div className="skills-pack-skill-list">
            {props.packs.map(pack => (
              <label key={pack.id} className="skills-pack-skill-item">
                <input type="checkbox" checked={packDraft.has(pack.id)} onChange={() => togglePack(pack.id)} />
                <span>{pack.name}</span>
                <small>{tr('skills.skillCount', { count: pack.include.length })}</small>
              </label>
            ))}
            {props.packs.length === 0 && <small className="muted">{tr('skills.packsEmpty')}</small>}
          </div>
        </div>

        <div className="skills-control-block">
          <label>{tr('skills.individualSkills')} ({tr('skills.advanced')})</label>
          <div className="skills-pack-skill-list">
            {props.skills.map(skill => (
              <label key={skill.name} className="skills-pack-skill-item">
                <input type="checkbox" checked={skillDraft.has(skill.name)} onChange={() => toggleSkill(skill.name)} />
                <span>{skill.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="skills-control-block">
          <label>{tr('skills.resolvedPreview')} ({resolvedPreview.length})</label>
          <div className="skills-resolved-preview">
            {resolvedPreview.map(({ name, source }) => (
              <div key={name} className="skills-resolved-item">
                <span>{name}</span>
                <small className="muted">{source}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="skills-dialog-actions">
          <button type="button" className="bd-button" onClick={props.onClose}>{tr('skills.cancel')}</button>
          <button type="submit" className="bd-button primary" disabled={busy}>
            {busy ? tr('skills.saving') : tr('skills.saveSelection')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
