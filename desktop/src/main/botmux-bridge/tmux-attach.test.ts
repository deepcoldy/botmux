import { describe, expect, it } from 'vitest'
import {
  botmuxTmuxSessionName,
  buildLocalTmuxAttachShell,
  buildRemoteTmuxAttachShell,
  buildSshTmuxAttachShell,
  shellQuote
} from './tmux-attach'

describe('botmuxTmuxSessionName', () => {
  it('uses first 8 chars of session id', () => {
    expect(botmuxTmuxSessionName('87cc0ea8-abcd-ef00')).toBe('bmx-87cc0ea8')
  })

  it('falls back for empty id', () => {
    expect(botmuxTmuxSessionName('')).toBe('bmx-unknown')
  })
})

describe('shellQuote', () => {
  it('leaves safe tokens bare', () => {
    expect(shellQuote('bmx-87cc0ea8')).toBe('bmx-87cc0ea8')
    expect(shellQuote('user@host')).toBe('user@host')
  })

  it('quotes spaces and special chars', () => {
    expect(shellQuote('a b')).toBe("'a b'")
  })
})

describe('buildLocalTmuxAttachShell', () => {
  it('does not use bare exec (failed attach must keep shell)', () => {
    const line = buildLocalTmuxAttachShell('bmx-87cc0ea8')
    expect(line.startsWith('exec ')).toBe(false)
    expect(line).not.toMatch(/\bexec tmux\b/)
    expect(line).toContain('tmux attach-session -t bmx-87cc0ea8')
    expect(line).toContain('||')
    expect(line).toContain('could not attach')
    // No trailing newline — PTY startup adds exactly one submit byte.
    expect(line).not.toMatch(/[\r\n]$/)
  })
})

describe('buildSshTmuxAttachShell', () => {
  it('builds ssh -tt with fail-open shell and timeouts', () => {
    const line = buildSshTmuxAttachShell(
      'ubuntu@d2.example',
      ['-i', '/tmp/key', '-o', 'IdentitiesOnly=yes'],
      'bmx-87cc0ea8'
    )
    expect(line.startsWith('exec ')).toBe(false)
    expect(line).toContain('ssh -tt')
    expect(line).toContain('ConnectTimeout=20')
    expect(line).toContain('BatchMode=yes')
    expect(line).toContain('ubuntu@d2.example')
    expect(line).toContain('tmux attach-session -t bmx-87cc0ea8')
    expect(line).toContain('||')
    expect(line).toContain('SSH/tmux attach')
  })
})

describe('buildRemoteTmuxAttachShell', () => {
  it('matches local attach (no nested ssh)', () => {
    expect(buildRemoteTmuxAttachShell('bmx-deadbeef')).toBe(
      buildLocalTmuxAttachShell('bmx-deadbeef')
    )
  })
})
