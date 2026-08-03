import { useMemo, useState } from 'react';
import { useT } from '../react-hooks.js';
import { SectionHeader } from '../dashboard-components.js';
import { buildSkillGraph, packIds, priorityNames, type BotGraphInfo } from './shared.js';
import type { BotRow, SkillRow, StatusMessage } from './types.js';

interface BotAssignmentsTabProps {
  bots: BotRow[];
  skills: SkillRow[];
  statuses: Record<string, StatusMessage>;
  onSave: (appId: string, names: string[], packIds: string[]) => Promise<void>;
  packs: Array<{ id: string; name: string; include: string[] }>;
}

type DragItem = { type: 'skill' | 'pack'; id: string };

export function BotAssignmentsTab(props: BotAssignmentsTabProps) {
  const tr = useT();
  const [editingBot, setEditingBot] = useState<BotRow | null>(null);
  const [dragOverBot, setDragOverBot] = useState<string | null>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [skillQuery, setSkillQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Single relationship model: per-bot resolution, counts and health all come
  // from the same graph the other skill tables use.
  const graph = useMemo(
    () => buildSkillGraph(props.skills, props.packs, props.bots),
    [props.skills, props.packs, props.bots],
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
    if (!dragItem) return;
    setDragOverBot(null);
    setDragItem(null);
    const currentSkills = priorityNames(bot.skills);
    const currentPacks = packIds(bot.skills);
    if (dragItem.type === 'skill') {
      if (currentSkills.includes(dragItem.id)) return;
      await props.onSave(bot.larkAppId, [...currentSkills, dragItem.id], currentPacks);
    } else {
      if (currentPacks.includes(dragItem.id)) return;
      await props.onSave(bot.larkAppId, currentSkills, [...currentPacks, dragItem.id]);
    }
  };

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
          {props.packs.length > 0 && (
            <div className="skills-bot-palette-group">
              <span className="skills-bot-palette-label">{tr('skills.packChips')}</span>
              <div className="skills-bot-palette-items">
                {props.packs.map(pack => (
                  <span
                    key={pack.id}
                    className="skills-draggable-chip skills-pack-chip"
                    draggable
                    onDragStart={() => setDragItem({ type: 'pack', id: pack.id })}
                    onDragEnd={() => { setDragItem(null); setDragOverBot(null); }}
                    title={`${pack.name} (${pack.include.length} skills)`}
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
                  onDragStart={() => setDragItem({ type: 'skill', id: skill.name })}
                  onDragEnd={() => { setDragItem(null); setDragOverBot(null); }}
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
                  return (
                    <tr
                      key={bot.larkAppId}
                      className={`skills-bot-row${isDragOver ? ' drag-over' : ''}`}
                      onDragOver={e => { e.preventDefault(); setDragOverBot(bot.larkAppId); }}
                      onDragLeave={() => setDragOverBot(prev => prev === bot.larkAppId ? null : prev)}
                      onDrop={e => { e.preventDefault(); void handleDrop(bot); }}
                    >
                      <td>{bot.botName ?? bot.larkAppId}</td>
                      <td>
                        <div className="skills-pack-chips">
                          {packNames.length === 0 ? <span className="muted">—</span> :
                            packNames.map(pid => {
                              const pack = props.packs.find(p => p.id === pid);
                              return <span key={pid} className="skills-pack-chip">{pack?.name ?? pid}</span>;
                            })}
                        </div>
                      </td>
                      <td>
                        {skillNames.length === 0 ? <span className="muted">—</span> :
                          <span className="skills-skill-chips">
                            {skillNames.slice(0, 3).map(n => <span key={n} className="skills-skill-chip">{n}</span>)}
                            {skillNames.length > 3 && <span className="muted">+{skillNames.length - 3}</span>}
                          </span>}
                      </td>
                      <td>{finalCount}</td>
                      <td>
                        <span className={`skills-health skills-health-${health.level}`}>
                          {health.label}
                        </span>
                      </td>
                      <td>
                        <button className="bd-button" onClick={() => setEditingBot(bot)}>
                          {tr('skills.select')}
                        </button>
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
function botHealthLabel(info: BotGraphInfo | undefined, tr: ReturnType<typeof useT>): { level: 'ok' | 'warn' | 'error'; label: string } {
  switch (info?.health) {
    case 'pack_missing': return { level: 'error', label: tr('skills.healthPackMissing') };
    case 'missing': return { level: 'warn', label: tr('skills.healthMissing', { count: info.missingSkills.length }) };
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
      <form method="dialog" data-action="save-bot-assignment" onSubmit={e => { e.preventDefault(); void save(); }}>
        <h3>{tr('skills.botEdit')}: {props.bot.botName ?? props.bot.larkAppId}</h3>
        {props.status && <p className={`hint-${props.status.ok ? 'ok' : 'warn'}`}>{props.status.text}</p>}

        <div className="skills-control-block">
          <label>{tr('skills.packChips')}</label>
          <div className="skills-pack-skill-list">
            {props.packs.map(pack => (
              <label key={pack.id} className="skills-pack-skill-item">
                <input type="checkbox" checked={packDraft.has(pack.id)} onChange={() => togglePack(pack.id)} />
                <span>{pack.name}</span>
                <small>{pack.include.length} skills</small>
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
