// Why: single source of truth for the commit trailer Botmux appends when the
// "Botmux Attribution" toggle (`enableGitHubAttribution`) is on. Used by both
// the terminal git/gh shim and the AI commit-message generator so the two
// code paths agree on the exact string.

export const BOTMUX_GIT_COMMIT_TRAILER = 'Co-authored-by: Botmux <help@stably.ai>'
