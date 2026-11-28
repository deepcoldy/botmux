/** Dependency-free command-head predicate shared by routing/privacy boundaries. */
export function isTraeLoginCompleteCommandText(text: string): boolean {
  return /^\s*\/dashboard\s+trae-login\s+complete\b/i.test(text);
}
