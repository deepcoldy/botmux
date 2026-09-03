# Bot Description Auto-Load Design

## Context

The Bot Config profile header currently renders an empty description preview (`—`) until the user clicks the edit icon. The click opens the editor and performs the first Open Platform read. Users expect the selected bot's current primary-language description to appear without an extra action.

## Chosen behavior

- When `BotDescriptionControl` mounts for a selected bot, it performs one description GET.
- A successful read immediately populates the profile preview and the per-language edit drafts.
- The edit icon only opens the editor. It does not issue a second GET for data that was just loaded.
- Switching to another bot mounts a new control and reads that bot's descriptions once. Switching back reads again, so the preview reflects the current Open Platform value rather than a session cache.
- Login recovery, language-change recovery, and post-publish state updates continue to use the existing explicit reload paths.

## Component and data flow

`BotDescriptionControl` remains the owner of the description snapshot, drafts, loading state, login state, and editor state.

1. A mount effect calls the existing `loadDescriptions()` callback.
2. `loadDescriptions()` keeps the current bounded GET, response validation, draft construction, and error mapping.
3. `openEditor()` changes to only set `open=true`; it consumes the snapshot and drafts already loaded by the mount effect.
4. A successful publish continues to replace the local snapshot and preview immediately.
5. A login success or `languages_changed` response may explicitly reload because external state has changed.

The parent already keys the selected bot detail by application ID, so changing bots gives the control a clean lifecycle without adding a cross-bot cache.

## Loading and error states

- While the automatic read is in flight, the edit icon is disabled and the existing “reading description” status is shown.
- If the read requires login, the existing login action remains visible in the profile header and editor.
- Other errors remain inline and do not block the rest of Bot Config.
- Opening the editor after a failed read shows the same status and no language rows; completing login triggers the existing retry.

## Testing and acceptance

- A regression test proves the component starts `loadDescriptions()` from a mount effect.
- A regression test proves `openEditor()` no longer starts another read.
- Existing tests continue to cover response validation, drafts, Unicode limits, login recovery, publishing, i18n, and layout.
- Browser acceptance: navigating to Bot Config and selecting a bot causes a description GET without clicking the icon; the preview changes from the loading state to the primary-language description; opening the editor causes no duplicate GET and the text remains editable.

## Out of scope

- Preloading descriptions for every bot in the roster.
- Caching descriptions across bot selections.
- Polling Open Platform for external changes.
- Changing the set or order of configured languages.
