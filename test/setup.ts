/**
 * Global mocha setup — required before any test file (see .mocharc.json).
 *
 * Windows CI portability: Git for Windows ships with `core.autocrlf=true` by
 * default, which rewrites LF to CRLF on checkout. Many test fixtures write
 * files with explicit `\n`, commit them, then read the git-checked-out copy
 * back and compare bytes (`run-push-*`, `clone-and-stack-push`,
 * `bare-path-diff`, `git-pack`, `full-summary`). With autocrlf on, those
 * round-trips come back as `\r\n` and the assertions fail spuriously.
 *
 * Rather than touch ~8 test files individually, force no line-ending
 * conversion for *every* git process spawned during the test run — including
 * the ones spawned deep inside src/ code — via git's GIT_CONFIG_* environment
 * injection (supported since git 2.31). This is process-scoped, so it never
 * leaks into the developer's global git config.
 */

const existingCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0

process.env[`GIT_CONFIG_KEY_${existingCount}`] = 'core.autocrlf'
process.env[`GIT_CONFIG_VALUE_${existingCount}`] = 'false'
process.env.GIT_CONFIG_COUNT = String(existingCount + 1)
