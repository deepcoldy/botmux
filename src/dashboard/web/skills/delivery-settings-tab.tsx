import type { ReactNode } from 'react';
import { useT } from '../react-hooks.js';
import { SectionHeader } from '../dashboard-components.js';
import type { BotRow, DeliveryMode, ProjectTrustMode, StatusMessage } from './types.js';

interface DeliverySettingsTabProps {
  trustProjectSkills: ProjectTrustMode;
  delivery: DeliveryMode;
  globalBusy: 'project' | 'delivery' | null;
  onUpdateProject: (value: ProjectTrustMode) => void;
  onUpdateDelivery: (value: DeliveryMode) => void;
  bots: BotRow[];
  onUpdateBotInjection: (appId: string, value: 'global' | 'prompt' | 'off') => void;
  botStatuses: Record<string, StatusMessage>;
  SkillSegmented: <T extends string>(props: {
    value: T;
    options: Array<{ value: T; label: ReactNode; help?: ReactNode }>;
    disabled?: boolean;
    onChange(value: T): void;
  }) => React.JSX.Element;
}

export function DeliverySettingsTab(props: DeliverySettingsTabProps) {
  const tr = useT();
  const { SkillSegmented } = props;

  return (
    <div className="skills-page-stack">
      <section className="skills-config-block">
        <SectionHeader title={tr('skills.globalDefaults')} />
        <article className="bd-card skills-defaults-panel skills-config-card">
          <div className="skills-control-block">
            <span className="skills-control-label">{tr('skills.globalProject')}</span>
            <SkillSegmented
              value={props.trustProjectSkills}
              disabled={props.globalBusy === 'project'}
              options={[
                { value: 'off', label: tr('skills.globalProjectOff'), help: tr('skills.globalProjectOffHelp') },
                { value: 'all', label: tr('skills.globalProjectAll'), help: tr('skills.globalProjectAllHelp') },
              ]}
              onChange={value => props.onUpdateProject(value)}
            />
          </div>
          <div className="skills-control-block">
            <span className="skills-control-label">
              {tr('skills.globalDelivery')}
              <small className="skills-scope-note">{tr('skills.scopeGlobal')}</small>
            </span>
            <SkillSegmented
              value={props.delivery}
              disabled={props.globalBusy === 'delivery'}
              options={[
                { value: 'auto', label: tr('skills.deliveryAuto'), help: tr('skills.deliveryAutoHelp') },
                { value: 'prompt', label: tr('skills.deliveryPrompt'), help: tr('skills.deliveryPromptHelp') },
                { value: 'native', label: tr('skills.deliveryNative'), help: tr('skills.deliveryNativeHelp') },
              ]}
              onChange={value => props.onUpdateDelivery(value)}
            />
          </div>
        </article>
      </section>

      <section className="skills-config-block">
        <SectionHeader
          title={tr('skills.botInjection')}
          hint={tr('skills.botInjectionHelp')}
        />
        <article className="bd-card skills-config-card">
          <p className="skills-injection-note">{tr('skills.botInjectionNote')}</p>
          <div className="skills-bot-injection-table">
            <table>
              <thead>
                <tr>
                  <th>{tr('skills.bot')}</th>
                  <th>{tr('skills.cli')}</th>
                  <th>{tr('skills.injection')}</th>
                  <th>{tr('skills.status')}</th>
                </tr>
              </thead>
              <tbody>
                {props.bots.map(bot => (
                  <tr key={bot.larkAppId}>
                    <td>{bot.botName ?? bot.larkAppId}</td>
                    <td><code>{bot.cliId ?? ''}</code></td>
                    <td>
                      <SkillSegmented
                        value={(bot.skillInjection ?? bot.skillInjectionDefault ?? 'prompt') as 'global' | 'prompt' | 'off'}
                        options={[
                          { value: 'global', label: tr('skills.injectionGlobal'), help: tr('skills.injectionGlobalHelp') },
                          { value: 'prompt', label: tr('skills.injectionPrompt'), help: tr('skills.injectionPromptHelp') },
                          { value: 'off', label: tr('skills.injectionOff'), help: tr('skills.injectionOffHelp') },
                        ]}
                        onChange={value => props.onUpdateBotInjection(bot.larkAppId, value)}
                      />
                    </td>
                    <td>
                      {props.botStatuses[bot.larkAppId] ? (
                        <span className={`hint-${props.botStatuses[bot.larkAppId]!.ok ? 'ok' : 'warn'}`}>
                          {props.botStatuses[bot.larkAppId]!.text}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </div>
  );
}
