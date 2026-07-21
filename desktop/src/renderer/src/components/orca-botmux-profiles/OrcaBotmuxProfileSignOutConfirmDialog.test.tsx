// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrcaProfileSignOutConfirmDialog } from './OrcaBotmuxProfileSignOutConfirmDialog'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>
}))

describe('OrcaProfileSignOutConfirmDialog', () => {
  it('describes account sign-out without presenting a local profile or warning', () => {
    const html = renderToStaticMarkup(
      <OrcaProfileSignOutConfirmDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        signingOut={false}
      />
    )

    expect(html).toContain('Sign out of OrcaBotmux?')
    expect(html).toContain(
      'You&#x27;ll be signed out of OrcaBotmux on this device. Your local projects and worktrees won&#x27;t be affected.'
    )
    expect(html).not.toContain('Personal')
    expect(html).not.toContain('alert-triangle')
  })
})
