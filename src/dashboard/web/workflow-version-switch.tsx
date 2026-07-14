import { useT } from './react-hooks.js';

type WorkflowVersion = 'legacy' | 'v3';

export function WorkflowVersionSwitch(props: {
  active: WorkflowVersion;
  legacyHref?: string;
  v3Href?: string;
}): JSX.Element {
  const tr = useT();
  const legacyActive = props.active === 'legacy';
  const v3Active = props.active === 'v3';

  return (
    <nav className="wf-subnav workflow-version-switch dashboard-toolbar" role="tablist" aria-label={tr('nav.workflows')}>
      <a
        href={props.legacyHref ?? '#/legacy-workflow'}
        className={legacyActive ? 'active' : ''}
        role="tab"
        aria-selected={legacyActive}
      >
        {tr('workflow.version.legacy')}
      </a>
      <a
        href={props.v3Href ?? '#/workflows'}
        className={v3Active ? 'active' : ''}
        role="tab"
        aria-selected={v3Active}
      >
        {tr('workflow.version.v3')}
      </a>
    </nav>
  );
}
