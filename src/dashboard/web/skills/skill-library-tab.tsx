import { useEffect, useRef, useState } from 'react';
import { extractSkillsInstallCommandSource } from '../../../core/skills/install-command.js';
import { useT } from '../react-hooks.js';
import { toast } from '../toast.js';
import type { SkillGraph } from './shared.js';
import type { InstallSkillCandidate, NativeSkillGroup, SkillRow, SkillsNavIntent, StatusMessage } from './types.js';

interface SkillLibraryTabProps {
  skills: SkillRow[];
  nativeSkillGroups: NativeSkillGroup[];
  installSource: string;
  installPath: string;
  installRef: string;
  installFullDepth: boolean;
  installStatus: StatusMessage;
  installBusy: boolean;
  installDiscovering: boolean;
  installSelectionOpen: boolean;
  installCandidates: InstallSkillCandidate[];
  selectedInstallSkills: Set<string>;
  onInstallSourceChange: (v: string) => void;
  onInstallPathChange: (v: string) => void;
  onInstallRefChange: (v: string) => void;
  onInstallFullDepthChange: (v: boolean) => void;
  onToggleInstallSkill: (name: string) => void;
  onSelectAllInstallSkills: (selected: boolean) => void;
  onConfirmInstallSelection: () => Promise<string[] | null>;
  onCloseInstallSelection: () => void;
  onInstall: () => Promise<string[] | null>;
  onOpenNativeDiscovery: () => void;
  onCreatePack: (input: { id: string; name: string; skillNames: string[] }) => Promise<void>;
  InstallPanel: React.ComponentType<any>;
  InstalledLibrary: React.ComponentType<any>;
  RemoveDialog: React.ComponentType<any>;
  removingNames: Set<string>;
  removalDialogOpen: boolean;
  pendingRemoval: string[] | null;
  removalReferences: Array<{ name: string; bots: string[] }>;
  removalError: string | null;
  skillBusy: string | null;
  installedStatus: StatusMessage;
  onUpdateSkill: (name: string) => void;
  onRequestRemove: (names: string[]) => void;
  onCancelRemoval: () => void;
  onConfirmRemoval: (force: boolean) => void;
  /** cross-tab navigation context (consumed once on arrival) */
  navIntent?: SkillsNavIntent | null;
  onNavIntentConsumed?: () => void;
  /** missing skill the user came here to install — prefill only, never auto-install */
  installTargetSkill?: string | null;
  /** clear the sticky target shown above the single-page install form */
  onClearInstallTarget?: () => void;
  /** false = pack data never loaded; usage chips must not claim "0 packs" */
  packsKnown?: boolean;
  /** focus the install form for a referenced-but-missing skill */
  onInstallMissing?: (name: string) => void;
  graph?: SkillGraph;
  packNames?: Array<{ id: string; name: string }>;
  onShowSkillPacks?: (name: string) => void;
  onShowSkillBots?: (name: string) => void;
  /** single-skill install finished: show a toast with a "assign to bot" action */
  onAssignInstalledSkill?: (skillName: string) => void;
}

export function SkillLibraryTab(props: SkillLibraryTabProps) {
  const tr = useT();
  const [installedForPack, setInstalledForPack] = useState<string[] | null>(null);
  const installAnchorRef = useRef<HTMLDivElement | null>(null);
  const { navIntent, onNavIntentConsumed } = props;

  // Apply an incoming cross-tab intent exactly once: the search prefill is
  // picked up by InstalledLibrary (child effects run first), then bring the
  // single-page install form into view without triggering any write.
  useEffect(() => {
    if (!navIntent) return;
    if (navIntent.openInstallWizard) {
      const anchor = installAnchorRef.current;
      anchor?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      anchor?.querySelector<HTMLInputElement>('input[data-install="source"]')?.focus();
    }
    onNavIntentConsumed?.();
  }, [navIntent, onNavIntentConsumed]);

  const finishInstall = (installed: string[] | null) => {
    if (!installed || installed.length === 0) return;
    if (installed.length > 1) {
      setInstalledForPack(installed);
    } else if (props.onAssignInstalledSkill) {
      const name = installed[0];
      toast(tr('skills.installSuccess', { skill: name }), {
        kind: 'success',
        duration: 5000,
        action: {
          label: tr('skills.assignToBot'),
          onClick: () => props.onAssignInstalledSkill!(name),
        },
      });
    }
  };

  return (
    <div className="skills-page-stack">
      <div className="skills-install-anchor" ref={installAnchorRef}>
        <props.InstallPanel
          installSource={props.installSource}
          installPath={props.installPath}
          installRef={props.installRef}
          installFullDepth={props.installFullDepth}
          installTargetSkill={props.installTargetSkill ?? null}
          installStatus={props.installStatus}
          installBusy={props.installBusy}
          installDiscovering={props.installDiscovering}
          installSelectionOpen={props.installSelectionOpen}
          installCandidates={props.installCandidates}
          selectedInstallSkills={props.selectedInstallSkills}
          onInstallSourceChange={props.onInstallSourceChange}
          onInstallPathChange={props.onInstallPathChange}
          onInstallRefChange={props.onInstallRefChange}
          onInstallFullDepthChange={props.onInstallFullDepthChange}
          onClearInstallTarget={props.onClearInstallTarget}
          onToggleInstallSkill={props.onToggleInstallSkill}
          onSelectAllInstallSkills={props.onSelectAllInstallSkills}
          onConfirmInstallSelection={() => { void props.onConfirmInstallSelection().then(finishInstall); }}
          onCloseInstallSelection={props.onCloseInstallSelection}
          onInstall={() => { void props.onInstall().then(finishInstall); }}
          onOpenNativeDiscovery={props.onOpenNativeDiscovery}
        />
      </div>

      {installedForPack && (
        <PostInstallPackDialog
          skillNames={installedForPack}
          onClose={() => setInstalledForPack(null)}
          onCreate={async input => {
            await props.onCreatePack(input);
            setInstalledForPack(null);
          }}
        />
      )}

      <props.InstalledLibrary
        skills={props.skills}
        busySkill={props.skillBusy}
        removingNames={props.removingNames}
        status={props.installedStatus}
        onUpdate={props.onUpdateSkill}
        onRequestRemove={props.onRequestRemove}
        externalQuery={props.navIntent?.librarySearch ?? null}
        externalFilterNames={props.navIntent?.libraryFilterSkills ?? null}
        packsKnown={props.packsKnown}
        onInstallMissing={props.onInstallMissing}
        graph={props.graph}
        packNames={props.packNames}
        onShowSkillPacks={props.onShowSkillPacks}
        onShowSkillBots={props.onShowSkillBots}
      />

      <props.RemoveDialog
        names={props.removalDialogOpen ? props.pendingRemoval : null}
        references={props.removalReferences}
        busy={props.removingNames.size > 0}
        error={props.removalError}
        onCancel={props.onCancelRemoval}
        onConfirm={props.onConfirmRemoval}
      />
    </div>
  );
}

function PostInstallPackDialog(props: {
  skillNames: string[];
  onClose: () => void;
  onCreate: (input: { id: string; name: string; skillNames: string[] }) => Promise<void>;
}) {
  const tr = useT();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) {
      try { dlg.showModal(); } catch { /* already open */ }
    }
  }, []);

  const create = async () => {
    if (!id.trim() || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreate({ id: id.trim(), name: name.trim(), skillNames: props.skillNames });
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="bd-dialog skills-post-install-pack" ref={dialogRef} onClose={() => !busy && props.onClose()}>
      <form method="dialog" onSubmit={event => { event.preventDefault(); void create(); }}>
        <h3>{tr('skills.postInstallPackTitle')}</h3>
        <p>{tr('skills.postInstallPackHelp', { count: props.skillNames.length })}</p>
        <div className="skills-control-block">
          <label>{tr('skills.packId')}</label>
          <input autoFocus required value={id} onChange={event => setId(event.target.value)} />
        </div>
        <div className="skills-control-block">
          <label>{tr('skills.packName')}</label>
          <input required value={name} onChange={event => setName(event.target.value)} />
        </div>
        <div className="skills-resolved-preview">
          <strong>{tr('skills.postInstallPackSkills')}</strong>
          <ul>{props.skillNames.map(skillName => <li key={skillName}><code>{skillName}</code></li>)}</ul>
        </div>
        {error && <p className="hint-warn">{error}</p>}
        <div className="skills-dialog-actions">
          <button type="button" className="bd-button" disabled={busy} onClick={props.onClose}>{tr('skills.postInstallPackSkip')}</button>
          <button type="submit" className="bd-button primary" disabled={busy || !id.trim() || !name.trim()}>
            {busy ? tr('skills.saving') : tr('skills.postInstallPackCreate')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Visual hint only — the daemon's parseSkillInstallSource() owns the real
 *  classification. Kept deliberately in sync with it so the wizard never
 *  promises a source type the backend would reject. Note this is a *hint*: a
 *  bare `owner/repo` that also exists as a local directory installs from disk,
 *  which only the daemon (with filesystem access) can know. */
export function detectSourceType(source: string): 'github' | 'git' | 'local' | 'agentbuddy' | 'unknown' {
  const s = source.trim();
  const lower = s.toLowerCase();
  if (!s) return 'unknown';
  // agentbuddy only via the canonical `agentbuddy:` scheme or a pasted install
  // command — NOT any string that happens to contain the word (a repo or local
  // path named "agentbuddy" is not an agentbuddy source).
  if (/^agentbuddy:/i.test(s)) return 'agentbuddy';
  if (/(?:^|\s)(?:npx\s+)?agentbuddy(?:@[\w.-]+)?\s+(?:skill|plugin)\s/i.test(s)) return 'agentbuddy';
  const skillsCommandSource = extractSkillsInstallCommandSource(s);
  if (skillsCommandSource) return detectSourceType(skillsCommandSource);
  if (lower.startsWith('github:')) return 'github';
  // Explicit git schemes are checked before github.com: `git@github.com:o/r.git`
  // is a git remote to the backend, not a browser URL.
  if (lower.startsWith('git+') || lower.startsWith('git@') || lower.startsWith('git://')) return 'git';
  if (lower.includes('github.com')) return 'github';
  // Any other http(s) URL is handled as a git remote by the backend.
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'git';
  if (lower.endsWith('.git')) return 'git';
  if (/^[/~.]/.test(s)) return 'local';
  // Bare `owner/repo[/path]` — GitHub shorthand, the most common paste form.
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:\/[\w./-]+)?$/.test(s)) return 'github';
  // The daemon treats every remaining scheme-less value as a local path,
  // including relative directories. Unsupported URL schemes remain unknown.
  return s.includes('://') ? 'unknown' : 'local';
}
