// Why: single source of truth for the commit trailer OrcaBotmux appends when the
// "OrcaBotmux Attribution" toggle (`enableGitHubAttribution`) is on. Used by both
// the terminal git/gh shim and the AI commit-message generator so the two
// code paths agree on the exact string.

export const ORCA_GIT_COMMIT_TRAILER = 'Co-authored-by: OrcaBotmux <help@stably.ai>'
