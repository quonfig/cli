type Flags = {
  interactive?: boolean
}

/**
 * Returns true when the CLI can safely prompt the user.
 *
 * Rules, in order:
 *   1. `--no-interactive` (flags.interactive === false) always wins → non-interactive.
 *   2. Otherwise require both stdin and stdout to be a TTY.
 *
 * Historical bug: this used to return `true` whenever `flags.interactive` was
 * truthy, which effectively bypassed the TTY check because the global
 * `--interactive` flag defaults to `true`. Under non-TTY stdio (CI, piped
 * stdin, `nohup`) the prompt helpers (`ux.prompt`, inquirer autocomplete)
 * would be invoked with no way to read input, leaving an unsettled
 * top-level await and emitting a raw Node warning (`Detected unsettled
 * top-level await`) with exit code 13. Now we always AND with the TTY check
 * so non-TTY contexts fall through to the command-level "pass --value and
 * --no-interactive" error message instead of hanging.
 *
 * @param flags - the parsed oclif flags (at minimum `interactive` is inspected)
 * @returns true if prompting is safe, false otherwise
 */
const isInteractive = (flags: Flags): boolean => {
  if (flags.interactive === false) {
    return false
  }

  return Boolean(process.stdout.isTTY && process.stdin.isTTY)
}

export default isInteractive
