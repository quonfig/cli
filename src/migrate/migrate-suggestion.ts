export interface PushConflictSuggestionInput {
  from: string
  /**
   * The original `--workspace` flag string the user typed, e.g.
   * `test-organization/semgrep-test-1`. Pass `undefined` if the user did not
   * pass `--workspace` (and the command resolved the workspace via the saved
   * profile). Never pass the resolved workspace UUID — the suggestion is meant
   * to be a copy-paste of the user's original invocation.
   */
  userWorkspaceFlag: string | undefined
}

export function buildPushConflictSuggestion({from, userWorkspaceFlag}: PushConflictSuggestionInput): string {
  const workspaceArg = userWorkspaceFlag ? ` --workspace ${userWorkspaceFlag}` : ''
  return `Re-run \`qfg migrate --from ${from}${workspaceArg} --push\` to pick up remote changes before retrying.`
}
