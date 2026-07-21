/**
 * Full multi-question / multi-select ask-hook card for Desktop operators.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type OrcaBotmuxAskQuestion = {
  prompt: string
  multiSelect: boolean
  options: Array<{ key: string; label: string }>
}

export type OrcaBotmuxAskCardProps = {
  askId: string
  hostLabel: string
  botName?: string
  questions: OrcaBotmuxAskQuestion[]
  deadlineAt?: number
  busy?: boolean
  onSubmit: (selections: string[][]) => void
  onDismiss?: () => void
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return translate('settings.orcaBotmuxBridge.askExpired', 'Expired')
  if (ms < 60_000) {
    return translate('settings.orcaBotmuxBridge.askSecondsLeft', '{{count}}s left', {
      count: Math.ceil(ms / 1000)
    })
  }
  if (ms < 3_600_000) {
    return translate('settings.orcaBotmuxBridge.askMinutesLeft', '{{count}}m left', {
      count: Math.ceil(ms / 60_000)
    })
  }
  return translate('settings.orcaBotmuxBridge.askHoursLeft', '{{count}}h left', {
    count: Math.ceil(ms / 3_600_000)
  })
}

export function OrcaBotmuxAskCard({
  hostLabel,
  botName,
  questions,
  deadlineAt,
  busy,
  onSubmit,
  onDismiss
}: OrcaBotmuxAskCardProps): React.JSX.Element {
  // selections[qIndex] = set of option keys
  const [picked, setPicked] = useState<Record<number, string[]>>(() => {
    const init: Record<number, string[]> = {}
    questions.forEach((_, i) => {
      init[i] = []
    })
    return init
  })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (deadlineAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deadlineAt])

  const remainingMs = deadlineAt != null ? Math.max(0, deadlineAt - now) : null
  const remainingLabel = remainingMs == null ? null : formatRemaining(remainingMs)
  const expired = remainingMs != null && remainingMs <= 0

  const canSubmit = useMemo(() => {
    if (expired) return false
    return questions.every((q, i) => {
      const sel = picked[i] ?? []
      if (q.multiSelect) return sel.length >= 1
      return sel.length === 1
    })
  }, [questions, picked, expired])

  const unanswered = useMemo(() => {
    return questions.filter((q, i) => {
      const sel = picked[i] ?? []
      return q.multiSelect ? sel.length < 1 : sel.length !== 1
    }).length
  }, [questions, picked])

  const toggle = (qIndex: number, key: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = prev[qIndex] ?? []
      if (multi) {
        const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
        return { ...prev, [qIndex]: next }
      }
      return { ...prev, [qIndex]: [key] }
    })
  }

  const submitLabel = expired
    ? translate('settings.orcaBotmuxBridge.askExpired', 'Expired')
    : busy
      ? translate('settings.orcaBotmuxBridge.askSubmitting', 'Submitting…')
      : unanswered > 0
        ? translate('settings.orcaBotmuxBridge.askAnswerMore', 'Answer {{count}} more…', {
            count: unanswered
          })
        : questions.length > 1
          ? translate('settings.orcaBotmuxBridge.askSubmitAll', 'Submit all answers')
          : translate('settings.orcaBotmuxBridge.askSubmit', 'Submit answer')

  return (
    <div
      className={cn(
        'rounded-md border px-2 py-2',
        expired
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-amber-500/40 bg-amber-500/5'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {hostLabel}
          {botName ? ` · ${botName}` : ''}
          {questions.length > 1 ? (
            <span className="ml-1 text-amber-700 dark:text-amber-400">
              {translate('settings.orcaBotmuxBridge.askQuestions', '· {{count}} questions', {
                count: questions.length
              })}
            </span>
          ) : null}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {remainingLabel ? (
            <span
              className={cn(
                expired
                  ? 'text-destructive'
                  : remainingMs != null && remainingMs < 30_000
                    ? 'font-medium text-amber-700 dark:text-amber-400'
                    : 'text-amber-700 dark:text-amber-400'
              )}
            >
              {remainingLabel}
            </span>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="text-[10px] underline-offset-2 hover:underline"
              onClick={onDismiss}
            >
              {translate('settings.orcaBotmuxBridge.askHide', 'hide')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 flex flex-col gap-3">
        {questions.map((q, qi) => {
          const sel = picked[qi] ?? []
          const needsPick = q.multiSelect ? sel.length < 1 : sel.length !== 1
          return (
            <div key={qi} className="flex flex-col gap-1">
              <div className="text-xs font-medium">
                {questions.length > 1 ? (
                  <span className="mr-1 text-muted-foreground">{qi + 1}.</span>
                ) : null}
                {q.prompt}
                {q.multiSelect ? (
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                    {translate('settings.orcaBotmuxBridge.askPickOneOrMore', '(pick one or more)')}
                  </span>
                ) : (
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                    {translate('settings.orcaBotmuxBridge.askPickOne', '(pick one)')}
                  </span>
                )}
                {needsPick && !expired ? (
                  <span className="ml-1 text-[10px] font-normal text-amber-700 dark:text-amber-400">
                    {translate('settings.orcaBotmuxBridge.askRequired', '· required')}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o) => {
                  const on = sel.includes(o.key)
                  return (
                    <Button
                      key={o.key}
                      type="button"
                      size="sm"
                      className={cn('h-7 text-[11px]', on && 'ring-1 ring-primary')}
                      variant={on ? 'default' : 'outline'}
                      disabled={busy || expired}
                      aria-pressed={on}
                      onClick={() => toggle(qi, o.key, q.multiSelect)}
                    >
                      {o.label}
                    </Button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <Button
        type="button"
        size="sm"
        className="mt-2 h-7 w-full text-[11px]"
        disabled={busy || !canSubmit}
        onClick={() => {
          const selections = questions.map((_, i) => picked[i] ?? [])
          onSubmit(selections)
        }}
      >
        {submitLabel}
      </Button>
    </div>
  )
}
