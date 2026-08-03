import { useEffect, useRef, useState } from 'react';
import { useT } from '../react-hooks.js';
import { SectionHeader } from '../dashboard-components.js';
import type { InstallSkillCandidate, NativeSkillGroup, SkillRow, StatusMessage } from './types.js';

interface SkillLibraryTabProps {
  skills: SkillRow[];
  nativeSkillGroups: NativeSkillGroup[];
  installSource: string;
  installPath: string;
  installRef: string;
  installStatus: StatusMessage;
  installBusy: boolean;
  installDiscovering: boolean;
  installSelectionOpen: boolean;
  installCandidates: InstallSkillCandidate[];
  selectedInstallSkills: Set<string>;
  onInstallSourceChange: (v: string) => void;
  onInstallPathChange: (v: string) => void;
  onInstallRefChange: (v: string) => void;
  onToggleInstallSkill: (name: string) => void;
  onSelectAllInstallSkills: (selected: boolean) => void;
  onConfirmInstallSelection: () => Promise<string[] | null>;
  onCloseInstallSelection: () => void;
  onInstall: () => Promise<string[] | null>;
  onOpenNativeDiscovery: () => void;
  onCreatePack: (input: { id: string; name: string; skillNames: string[] }) => Promise<void>;
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
}

export function SkillLibraryTab(props: SkillLibraryTabProps) {
  const tr = useT();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [installedForPack, setInstalledForPack] = useState<string[] | null>(null);

  const closeWizard = () => {
    props.onCloseInstallSelection();
    setWizardOpen(false);
  };

  const finishInstall = (installed: string[] | null) => {
    if (!installed || installed.length === 0) return;
    setWizardOpen(false);
    if (installed.length > 1) setInstalledForPack(installed);
  };

  return (
    <div className="skills-page-stack">
      <section className="skills-config-block">
        <SectionHeader
          title={tr('skills.install')}
          hint={tr('skills.installInfo')}
        >
          <button className="bd-button" onClick={props.onOpenNativeDiscovery}>{tr('skills.discover')}</button>
          <button className="bd-button primary" onClick={() => setWizardOpen(true)}>{tr('skills.installWizard')}</button>
        </SectionHeader>
        {wizardOpen && (
          <InstallWizard
            onClose={closeWizard}
            onSourceChange={props.onInstallSourceChange}
            onPathChange={props.onInstallPathChange}
            onRefChange={props.onInstallRefChange}
            onInstall={async () => finishInstall(await props.onInstall())}
            onConfirmSelection={async () => finishInstall(await props.onConfirmInstallSelection())}
            onCloseSelection={props.onCloseInstallSelection}
            onToggleSkill={props.onToggleInstallSkill}
            onSelectAll={props.onSelectAllInstallSkills}
            source={props.installSource}
            path={props.installPath}
            ref={props.installRef}
            busy={props.installBusy}
            discovering={props.installDiscovering}
            status={props.installStatus}
            selectionOpen={props.installSelectionOpen}
            candidates={props.installCandidates}
            selected={props.selectedInstallSkills}
          />
        )}
      </section>

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

function InstallWizard(props: {
  onClose: () => void;
  onSourceChange: (v: string) => void;
  onPathChange: (v: string) => void;
  onRefChange: (v: string) => void;
  onInstall: () => Promise<void>;
  onConfirmSelection: () => Promise<void>;
  onCloseSelection: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAll: (selected: boolean) => void;
  source: string;
  path: string;
  ref: string;
  busy: boolean;
  discovering: boolean;
  status: StatusMessage;
  selectionOpen: boolean;
  candidates: InstallSkillCandidate[];
  selected: Set<string>;
}) {
  const tr = useT();
  const [step, setStep] = useState(1);
  const sourceType = detectSourceType(props.source);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg && !dlg.open) {
      try { dlg.showModal(); } catch { /* already open */ }
    }
  }, []);

  return (
    <dialog className="bd-dialog skills-install-wizard" ref={dialogRef} onClose={props.onClose}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); }}>
        <h3>{tr('skills.installWizard')}</h3>
        <div className="skills-wizard-steps">
          <span className={step >= 1 ? 'active' : ''}>1. {tr('skills.wizSource')}</span>
          <span className={step >= 2 ? 'active' : ''}>2. {tr('skills.wizDetails')}</span>
          <span className={step >= 3 ? 'active' : ''}>3. {tr('skills.wizInstall')}</span>
        </div>

        {step === 1 && (
          <div className="skills-control-block">
            <label>{tr('skills.source')}</label>
            <input
              autoFocus
              value={props.source}
              onChange={e => props.onSourceChange(e.target.value)}
              placeholder={tr('skills.sourcePlaceholder')}
            />
            <div className="skills-wizard-source-hint">
              {sourceType === 'github' && <small>{tr('skills.sourceHelpRemote')}</small>}
              {sourceType === 'git' && <small>{tr('skills.sourceHelpRemote')}</small>}
              {sourceType === 'local' && <small>{tr('skills.sourceHelpLocal')}</small>}
              {sourceType === 'agentbuddy' && <small>{tr('skills.sourceHelpAgentbuddy')}</small>}
            </div>
          </div>
        )}

        {step === 2 && (
          <>
            {(sourceType === 'github' || sourceType === 'git') && (
              <div className="skills-control-block">
                <label>{tr('skills.ref')}</label>
                <input value={props.ref} onChange={e => props.onRefChange(e.target.value)} placeholder={tr('skills.refPlaceholder')} />
              </div>
            )}
            {(sourceType === 'github' || sourceType === 'git') && (
              <div className="skills-control-block">
                <label>{tr('skills.path')}</label>
                <input value={props.path} onChange={e => props.onPathChange(e.target.value)} placeholder={tr('skills.pathPlaceholder')} />
              </div>
            )}
            {sourceType === 'unknown' && <p className="hint-warn">{tr('skills.sourceRequired')}</p>}
          </>
        )}

        {step === 3 && (
          <div className="skills-control-block">
            <div className="skills-wizard-summary">
              <p><strong>{tr('skills.source')}:</strong> {props.source || '—'}</p>
              {props.ref && <p><strong>{tr('skills.ref')}:</strong> {props.ref}</p>}
              {props.path && <p><strong>{tr('skills.path')}:</strong> {props.path}</p>}
            </div>
            {props.discovering && <p className="hint-ok">{tr('skills.scanning')}…</p>}
            {!props.discovering && !props.selectionOpen && props.status && (
              <p className={`hint-${props.status.ok ? 'ok' : 'warn'}`}>{props.status.text}</p>
            )}
            {props.selectionOpen && (
              <div className="skills-install-selection">
                <div className="skills-install-selection-head">
                  <strong>{tr('skills.installSelectionTitle')}</strong>
                  <label>
                    <input
                      type="checkbox"
                      checked={props.candidates.length > 0 && props.candidates.every(candidate => props.selected.has(candidate.name))}
                      onChange={event => props.onSelectAll(event.target.checked)}
                    />
                    {tr('skills.selectAllSkills', { count: props.candidates.length })}
                  </label>
                </div>
                <p>{tr('skills.installSelectionHelp', { count: props.candidates.length })}</p>
                <div className="skills-pack-skill-list">
                  {props.candidates.map(candidate => (
                    <label key={candidate.name} className="skills-pack-skill-item">
                      <input type="checkbox" checked={props.selected.has(candidate.name)} onChange={() => props.onToggleSkill(candidate.name)} />
                      <span className="skills-pack-skill-name">{candidate.name}</span>
                      {candidate.description && <small className="skills-pack-skill-desc">{candidate.description}</small>}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="skills-dialog-actions">
          <button type="button" className="bd-button" onClick={props.onClose}>{tr('skills.cancel')}</button>
          {step > 1 && <button type="button" className="bd-button" onClick={() => { props.onCloseSelection(); setStep(s => s - 1); }}>{tr('skills.wizBack')}</button>}
          {step < 3 && <button type="button" className="bd-button primary" onClick={() => {
            if (step === 2) {
              // Run discover when entering step 3 so the user sees a preview
              void props.onInstall();
            }
            setStep(s => s + 1);
          }} disabled={step === 1 && !props.source.trim()}>{tr('skills.wizNext')}</button>}
          {step === 3 && (
            <button
              type="button"
              className="bd-button primary"
              disabled={props.busy || props.discovering || (props.selectionOpen && props.selected.size === 0)}
              onClick={() => { void (props.selectionOpen ? props.onConfirmSelection() : props.onInstall()); }}
            >
              {props.discovering ? tr('skills.scanning') : props.busy ? tr('skills.jobRunning') : props.selectionOpen ? tr('skills.installSelected') : tr('skills.installSubmit')}
            </button>
          )}
        </div>
      </form>
    </dialog>
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

function detectSourceType(source: string): 'github' | 'git' | 'local' | 'agentbuddy' | 'zip' | 'unknown' {
  const s = source.trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('agentbuddy')) return 'agentbuddy';
  if (s.endsWith('.zip') || s.includes('.zip')) return 'zip';
  if (s.includes('github.com')) return 'github';
  // Any http(s) URL that's not github is treated as a generic git repo
  if (s.startsWith('http://') || s.startsWith('https://')) return 'git';
  if (s.startsWith('git@') || s.startsWith('git://') || s.endsWith('.git')) return 'git';
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('~')) return 'local';
  if (s.includes('github')) return 'github';
  return 'unknown';
}
