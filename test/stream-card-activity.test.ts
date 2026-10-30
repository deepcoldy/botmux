import { describe, expect, it } from 'vitest';
import { traexStreamCardActivity } from '../src/core/stream-card-activity.js';
import { buildStreamingCard, type ActivityCardLabel } from '../src/im/lark/card-builder.js';
import { t } from '../src/i18n/index.js';

const execution = { startedAtMs: 1000, workerGeneration: 2, lastProgressAtMs: 2000 };
const turn = { cliId: 'traex', status: 'working', workerGeneration: 2, execution, nowMs: 5000 };

describe('streaming execution activity', () => {
  it('advances elapsed and last progress age without inventing a failure', () => {
    expect(traexStreamCardActivity(turn)).toEqual({ activity: 'working', elapsedSeconds: 4, progressAgeSeconds: 3 });
    expect(traexStreamCardActivity({ ...turn, nowMs: 65_000 })).toEqual({ activity: 'working', elapsedSeconds: 64, progressAgeSeconds: 63 });
  });

  it('distinguishes a running tool, its completion, and native model capacity queue', () => {
    expect(traexStreamCardActivity({ ...turn, execution: { ...execution, stage: 'tool_started' } })?.activity).toBe('tool');
    expect(traexStreamCardActivity({ ...turn, execution: { ...execution, stage: 'tool_returned' } })?.activity).toBe('working');
    const queue = '◆ Queued for capacity (3s • esc to interrupt)';
    expect(traexStreamCardActivity({ ...turn, content: queue })?.activity).toBe('model_queue');
    expect(traexStreamCardActivity({ ...turn, content: '◆ Queued for next turn (3s • esc to interrupt)' })?.activity).toBe('working');
    expect(traexStreamCardActivity({ ...turn, content: `${queue}\n✧ Thinking… (4s • esc to interrupt)` })?.activity).toBe('working');
  });

  it('omits stale generations, unknown start times, settled turns, and other CLIs', () => {
    for (const input of [
      { ...turn, workerGeneration: 3 }, { ...turn, execution: undefined },
      { ...turn, nowMs: 500 }, { ...turn, status: 'idle' },
      { ...turn, status: 'limited' }, { ...turn, cliId: 'claude-code' },
    ]) expect(traexStreamCardActivity(input)).toBeUndefined();
  });

  it.each(['zh', 'en'] as const)('renders phase and running time with output collapsed (%s)', locale => {
    function card(activity: ActivityCardLabel, status: 'working' | 'idle' = 'working') {
      return JSON.parse(buildStreamingCard('s', 'om_root', '', 'task', '', status, 'traex', 'hidden',
        undefined, undefined, false, false, locale, undefined, undefined, false,
        undefined, undefined, undefined, activity));
    }
    const activity = { activity: 'tool', elapsedSeconds: 64, progressAgeSeconds: 12 } as const;
    const running = card(activity);
    expect(running.header.title.content).toContain(t('card.status.tool_running', undefined, locale));
    const line = running.elements.find((element: any) => element.element_id === 'botmux_stream_activity');
    expect(line.content).toContain(t('card.status.activity_elapsed', { seconds: 64 }, locale));
    expect(line.content).toContain(t('card.status.activity_progress_age', { seconds: 12 }, locale));
    const waiting = card({ ...activity, activity: 'model_queue' });
    expect(waiting.header.title.content).toContain(t('card.status.model_queue', undefined, locale));
    expect(card(activity, 'idle').elements.some((element: any) => element.element_id === 'botmux_stream_activity')).toBe(false);
  });
});
