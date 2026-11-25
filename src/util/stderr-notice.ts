/**
 * Print a notice on stderr in every output mode, --json included: stdout
 * stays the command's result, and a person still sees the warning.
 */
export const notice = (text: string): void => {
  process.stderr.write(`${text}\n`)
}
