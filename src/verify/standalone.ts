/**
 * Standalone workspace validator.
 *
 * Usage:
 *   qfg-verify <workspace-dir>      Validate a workspace directory on disk
 *   qfg-verify --git-hook           Run as git pre-receive hook (reads stdin for refs,
 *                                   uses git commands to read files from the pushed commit)
 *
 * Exit codes:
 *   0  All checks pass
 *   1  Validation errors found
 */

import {execFileSync} from 'node:child_process'
import * as readline from 'node:readline'
import {formatResult, validateFileMap, validateWorkspace} from './validate.js'

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--git-hook')) {
    await runGitHook()
  } else if (args.includes('--help') || args.includes('-h')) {
    printUsage()
  } else {
    const dir = args[0] || '.'
    runDiskValidation(dir)
  }
}

function printUsage() {
  console.log(`qfg-verify - Quonfig workspace validator

Usage:
  qfg-verify [path]           Validate workspace directory (default: .)
  qfg-verify --git-hook       Run as git pre-receive hook
  qfg-verify --help           Show this help

Exit codes:
  0  All checks pass
  1  Validation errors found`)
}

function runDiskValidation(dir: string) {
  const result = validateWorkspace(dir)
  console.log(formatResult(result))
  process.exit(result.valid ? 0 : 1)
}

/**
 * Git pre-receive hook mode.
 *
 * Reads stdin for pushed refs (one line per ref: <old-oid> <new-oid> <ref-name>).
 * For each new commit, lists all config files and validates them.
 */
async function runGitHook() {
  const refs: Array<{oldOid: string; newOid: string; refName: string}> = []

  // Read all of stdin (ref lines). Use callback API for bun compatibility.
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({input: process.stdin})
    rl.on('line', (line: string) => {
      const parts = line.trim().split(' ')
      if (parts.length >= 3) {
        refs.push({oldOid: parts[0], newOid: parts[1], refName: parts[2]})
      }
    })
    rl.on('close', resolve)
  })

  if (refs.length === 0) {
    console.log('qfg-verify: no refs received')
    process.exit(0)
  }

  // Validate the latest pushed commit for each ref
  let hasErrors = false

  for (const ref of refs) {
    // Skip deletions
    if (ref.newOid === '0000000000000000000000000000000000000000') continue

    console.log(`qfg-verify: validating ${ref.refName} (${ref.newOid.slice(0, 8)})`)

    try {
      const files = readFilesFromCommit(ref.newOid)
      const result = validateFileMap(files)
      console.log(formatResult(result))

      if (!result.valid) {
        hasErrors = true
      }
    } catch (error: unknown) {
      console.error(`qfg-verify: error reading commit ${ref.newOid}: ${(error as Error).message}`)
      hasErrors = true
    }
  }

  process.exit(hasErrors ? 1 : 0)
}

/**
 * Read all JSON config files from a git commit using `git show`.
 * Works in bare repos (no working tree needed).
 *
 * qfg-6na9.6: uses execFileSync (never a shell) and `ls-tree -z` (NUL-delimited,
 * disables git's C-quoting of "unusual" paths). The old string-interpolated
 * execSync + default ls-tree output silently SKIPPED any filename containing a
 * space or non-ASCII char — exactly the Policy-A-violating keys the hook
 * exists to catch (verified live on staging: a `configs/bad charset key.json`
 * push was accepted unvalidated). A listed-but-unreadable file is now a hard
 * failure (fail closed), not a silent skip.
 */
export function readFilesFromCommit(commitOid: string, cwd?: string): Map<string, string> {
  const files = new Map<string, string>()
  const dirs = ['configs', 'feature-flags', 'segments', 'log-levels', 'schemas', 'schemas-protected']

  for (const dir of dirs) {
    // List files in this directory at the given commit. A directory that
    // doesn't exist yields an empty listing (exit 0); a bad/unreadable OID
    // throws — fail closed, the hook rejects the push.
    const listing = execFileSync('git', ['ls-tree', '-z', '--name-only', commitOid, `${dir}/`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const filenames = listing.split('\0').filter(Boolean)
    for (const filePath of filenames) {
      if (!filePath.endsWith('.json') || filePath.includes('/.')) continue

      // Fail closed: if a listed file can't be read, the push must not be
      // accepted with that file unvalidated — let the error propagate to the
      // hook's per-ref handler, which rejects the push.
      const content = execFileSync('git', ['show', `${commitOid}:${filePath}`], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      files.set(filePath, content)
    }
  }

  return files
}

// Only run as a program when compiled/executed as the entry point (Bun sets
// import.meta.main; under node test imports it is undefined) — this lets tests
// import readFilesFromCommit without triggering the CLI.
if ((import.meta as ImportMeta & {main?: boolean}).main) {
  main().catch((error) => {
    console.error(`qfg-verify: fatal: ${error.message}`)
    process.exit(1)
  })
}
