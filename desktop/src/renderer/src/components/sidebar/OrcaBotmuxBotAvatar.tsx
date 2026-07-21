/**
 * Bot (agent) avatar for Botmux session rows / agent headers: the Feishu bot
 * avatar image when the daemon provides one, else a deterministic letter tile
 * so distinct bots stay visually distinguishable.
 */
import React, { useState } from 'react'
import { cn } from '@/lib/utils'

/** djb2 → hue so a given bot name always lands on the same tile color. */
function hueForName(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

export function OrcaBotmuxBotAvatar({
  name,
  avatarUrl,
  className
}: {
  name?: string
  avatarUrl?: string
  className?: string
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const label = name?.trim() ?? ''
  const letter = (label[0] ?? '?').toUpperCase()

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        // Why: Feishu CDN URLs hotlink fine but some reject a foreign Referer.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('size-4 shrink-0 rounded-full bg-muted object-cover', className)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white',
        className
      )}
      style={{ backgroundColor: `hsl(${hueForName(label)} 45% 42%)` }}
    >
      {letter}
    </span>
  )
}
