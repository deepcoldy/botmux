import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_LOCAL_BOTMUX_PROFILE_ID,
  DEFAULT_LOCAL_BOTMUX_PROFILE_NAME,
  BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
  type BotmuxProfileIndex
} from '../../shared/botmux-profiles'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

async function loadProfileIndexStore() {
  vi.resetModules()
  return import('./profile-index-store')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('profile index store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'botmux-profile-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('creates the default local profile and copies legacy state without deleting it', async () => {
    const legacyState = { schemaVersion: 1, repos: [{ id: 'repo-1' }] }
    const legacyBackup = { schemaVersion: 1, repos: [{ id: 'backup-repo' }] }
    const legacyBrowserSessionMeta = {
      defaultSource: { browserFamily: 'chrome', importedAt: 1 },
      profiles: []
    }
    writeFileSync(join(testState.dir, 'botmux-data.json'), JSON.stringify(legacyState), 'utf-8')
    writeFileSync(
      join(testState.dir, 'botmux-data.json.bak.0'),
      JSON.stringify(legacyBackup),
      'utf-8'
    )
    writeFileSync(
      join(testState.dir, 'browser-session-meta.json'),
      JSON.stringify(legacyBrowserSessionMeta),
      'utf-8'
    )

    const { ensureActiveBotmuxProfile, getBotmuxProfileIndexPath } = await loadProfileIndexStore()
    const activeProfile = ensureActiveBotmuxProfile()

    expect(activeProfile.profile.id).toBe(DEFAULT_LOCAL_BOTMUX_PROFILE_ID)
    expect(activeProfile.profile.name).toBe(DEFAULT_LOCAL_BOTMUX_PROFILE_NAME)
    expect(activeProfile.dataFile).toBe(
      join(testState.dir, 'profiles', DEFAULT_LOCAL_BOTMUX_PROFILE_ID, 'botmux-data.json')
    )
    expect(readJson(activeProfile.dataFile)).toEqual(legacyState)
    expect(readJson(`${activeProfile.dataFile}.bak.0`)).toEqual(legacyBackup)
    expect(
      readJson(
        join(testState.dir, 'profiles', DEFAULT_LOCAL_BOTMUX_PROFILE_ID, 'browser-session-meta.json')
      )
    ).toEqual(legacyBrowserSessionMeta)
    expect(existsSync(join(testState.dir, 'botmux-data.json'))).toBe(true)

    expect(readJson(getBotmuxProfileIndexPath())).toMatchObject({
      schemaVersion: BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: DEFAULT_LOCAL_BOTMUX_PROFILE_ID,
      profiles: [expect.objectContaining({ id: DEFAULT_LOCAL_BOTMUX_PROFILE_ID, kind: 'local' })]
    })
  })

  it('uses an existing active profile data file without overwriting it from legacy state', async () => {
    const profileId = 'work-profile'
    const profileDirectory = join(testState.dir, 'profiles', profileId)
    const profileData = { schemaVersion: 1, repos: [{ id: 'profile-repo' }] }
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(join(profileDirectory, 'botmux-data.json'), JSON.stringify(profileData), 'utf-8')
    writeFileSync(
      join(testState.dir, 'botmux-data.json'),
      JSON.stringify({ schemaVersion: 1, repos: [{ id: 'legacy-repo' }] }),
      'utf-8'
    )
    const index: BotmuxProfileIndex = {
      schemaVersion: BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: profileId,
      profiles: [
        {
          id: profileId,
          name: 'Work',
          avatar: { kind: 'initials', initials: 'W', color: 'neutral' },
          kind: 'local',
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1
        }
      ]
    }
    writeFileSync(join(testState.dir, 'botmux-profile-index.json'), JSON.stringify(index), 'utf-8')

    const { ensureActiveBotmuxProfile } = await loadProfileIndexStore()
    const activeProfile = ensureActiveBotmuxProfile()

    expect(activeProfile.profile.id).toBe(profileId)
    expect(activeProfile.dataFile).toBe(join(profileDirectory, 'botmux-data.json'))
    expect(readJson(activeProfile.dataFile)).toEqual(profileData)
  })

  it('creates an empty local profile without copying legacy state into it', async () => {
    writeFileSync(
      join(testState.dir, 'botmux-data.json'),
      JSON.stringify({ schemaVersion: 1, repos: [{ id: 'legacy-repo' }] }),
      'utf-8'
    )

    const { createLocalBotmuxProfile, getBotmuxProfileDataFile, getBotmuxProfileListState } =
      await loadProfileIndexStore()
    const created = createLocalBotmuxProfile({ name: ' Work ' })

    expect(created.profile.name).toBe('Work')
    expect(created.profile.id).toMatch(/^local-/)
    expect(created.activeProfileId).toBe(DEFAULT_LOCAL_BOTMUX_PROFILE_ID)
    expect(created.profiles.map((profile) => profile.id)).toContain(created.profile.id)
    expect(existsSync(getBotmuxProfileDataFile(created.profile.id))).toBe(false)
    expect(getBotmuxProfileListState().profiles.map((profile) => profile.id)).toContain(
      created.profile.id
    )
  })

  it('switches the active profile and updates last-opened metadata', async () => {
    const { createLocalBotmuxProfile, setActiveBotmuxProfile } = await loadProfileIndexStore()
    const created = createLocalBotmuxProfile({ name: 'Work' })

    const switched = setActiveBotmuxProfile(created.profile.id)

    expect(switched.activeProfileId).toBe(created.profile.id)
    expect(switched.profiles.find((profile) => profile.id === created.profile.id)).toMatchObject({
      id: created.profile.id,
      lastOpenedAt: expect.any(Number)
    })
  })

  it('rejects switching to an unknown profile', async () => {
    const { setActiveBotmuxProfile } = await loadProfileIndexStore()

    expect(() => setActiveBotmuxProfile('missing-profile')).toThrow('unknown_botmux_profile')
  })

  it('recovers a corrupted profile index from the backup copy', async () => {
    const store = await loadProfileIndexStore()
    store.ensureActiveBotmuxProfile()
    const created = store.createLocalBotmuxProfile({ name: 'Work' })
    // Trigger one more write so the backup captures the two-profile index.
    store.setActiveBotmuxProfile(created.profile.id)

    const indexPath = store.getBotmuxProfileIndexPath()
    expect(existsSync(`${indexPath}.bak`)).toBe(true)
    writeFileSync(indexPath, '{ not json', 'utf-8')

    const recovered = store.getBotmuxProfileListState()
    expect(recovered.profiles.map((profile) => profile.id)).toContain(created.profile.id)
    expect(recovered.profiles.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects profile ids that are not safe path segments', async () => {
    const store = await loadProfileIndexStore()
    const indexPath = store.getBotmuxProfileIndexPath()
    const index: BotmuxProfileIndex = {
      schemaVersion: BOTMUX_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: '../../escape',
      profiles: [
        {
          id: '../../escape',
          name: 'Evil',
          avatar: { kind: 'initials', initials: 'E', color: 'neutral' },
          kind: 'local',
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1
        }
      ]
    }
    mkdirSync(testState.dir, { recursive: true })
    writeFileSync(indexPath, JSON.stringify(index), 'utf-8')

    // The tampered entry is filtered; startup falls back to a fresh default.
    const state = store.ensureActiveBotmuxProfile()
    expect(state.profile.id).toBe(DEFAULT_LOCAL_BOTMUX_PROFILE_ID)
  })
})
