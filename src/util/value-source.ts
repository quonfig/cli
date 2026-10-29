import {Flags} from '@oclif/core'

import {Result, failure, success} from '../result.js'

/**
 * qfg-38lp: ways to hand the CLI a value WITHOUT putting it in argv (where it
 * lands in shell history, `ps`, CI logs and agent transcripts).
 *
 *   --value-stdin              read the value from stdin
 *   --value-from-env <VAR>     read the value from a LOCAL env var, right now
 *
 * Not to be confused with --env-var, which stores no value at all: it records
 * that the SDK reads the value from that env var at RUNTIME.
 */
export const valueSourceFlags = {
  'value-from-env': Flags.string({
    description:
      'read the value to store from this LOCAL env var now (keeps it out of argv/shell history). Not the same as --env-var',
    helpValue: 'VAR',
  }),
  'value-stdin': Flags.boolean({
    default: false,
    description: 'read the value to store from stdin (one trailing newline is stripped). Keeps it out of argv',
  }),
}

/** Read all of stdin (tests swap `process.stdin` for a Readable). */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }

  return Buffer.concat(chunks).toString('utf8')
}

type ValueSourceInput = {
  'env-var'?: string
  value?: string
  'value-from-env'?: string
  'value-stdin'?: boolean
}

/** Strip exactly one trailing newline (`\n` or `\r\n`), as `echo`/heredocs add one. */
export const stripOneTrailingNewline = (s: string): string => {
  if (s.endsWith('\r\n')) return s.slice(0, -2)
  if (s.endsWith('\n')) return s.slice(0, -1)
  return s
}

/**
 * Resolve the value from --value / --value-stdin / --value-from-env, enforcing
 * that at most one of those (or --env-var) is given. Returns `undefined` when
 * none was given (the caller may then prompt or use --env-var).
 */
export const resolveValueSource = async (flags: ValueSourceInput): Promise<Result<string | undefined>> => {
  const given = [
    flags.value === undefined ? undefined : '--value',
    flags['value-stdin'] ? '--value-stdin' : undefined,
    flags['value-from-env'] === undefined ? undefined : '--value-from-env',
    flags['env-var'] === undefined ? undefined : '--env-var',
  ].filter(Boolean)

  if (given.length > 1) {
    return failure(
      `Pass only one of --value, --value-stdin, --value-from-env or --env-var (got ${given.join(' and ')}). ` +
        '--env-var stores no value: it tells the SDK to read the value from that env var at runtime.',
    )
  }

  if (flags['value-stdin']) {
    if (process.stdin.isTTY) {
      process.stderr.write('Reading value from stdin (finish with Ctrl-D)...\n')
    }

    const value = stripOneTrailingNewline(await readStdin())
    if (value === '') {
      return failure(
        '--value-stdin read an empty value from stdin. Pipe the value in, e.g. `pbpaste | qfg ... --value-stdin`.',
      )
    }

    return success(value)
  }

  const envName = flags['value-from-env']
  if (envName !== undefined) {
    const value = process.env[envName]
    if (value === undefined) {
      return failure(`--value-from-env: environment variable ${envName} is not set in this shell.`)
    }

    if (value === '') {
      return failure(`--value-from-env: environment variable ${envName} is empty.`)
    }

    return success(value)
  }

  return success(flags.value)
}
