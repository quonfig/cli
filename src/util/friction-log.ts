import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface FrictionEntry {
  attempted: string
  error: string
  exitCode: number
  ts: string
}

export function getDefaultFrictionLogPath(home: string = os.homedir()): string {
  return path.join(home, '.qfg', 'friction.log')
}

export function getFrictionLogPath(envValue?: string | undefined, cwd: string = process.cwd()): null | string {
  if (envValue === undefined) return null
  const trimmed = envValue.trim()
  if (trimmed === '' || trimmed === 'false' || trimmed === '0') return null
  if (trimmed === 'true' || trimmed === '1') {
    return getDefaultFrictionLogPath()
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed)
}

export function buildFrictionEntry(opts: {
  argv?: string[]
  binName?: string
  error?: string
  exitCode: number
  now?: Date
}): FrictionEntry {
  const argv = opts.argv ?? process.argv.slice(2)
  const binName = opts.binName ?? 'qfg'
  const error = opts.error?.trim() || `nonzero exit code ${opts.exitCode}`

  return {
    attempted: [binName, ...argv].join(' '),
    error,
    exitCode: opts.exitCode,
    ts: (opts.now ?? new Date()).toISOString(),
  }
}

export function appendFrictionEntry(logPath: string, entry: FrictionEntry): void {
  fs.mkdirSync(path.dirname(logPath), {recursive: true})
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8')
}

const MAX_STDERR_CAPTURE = 4000

export function extractLastErrorLine(stderr: string): string | undefined {
  if (!stderr) return undefined
  // eslint-disable-next-line no-control-regex
  const stripped = stderr.replaceAll(/\u001B\[[\d;]*[A-Za-z]/g, '')
  const lines = stripped
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined
  const errorLine = [...lines].reverse().find((l) => /^(error|»|×|✖)/i.test(l))
  return (errorLine ?? lines.at(-1))?.replace(/^»\s*/, '').replace(/^error:\s*/i, '')
}

export function installStderrCapture(): () => string {
  let captured = ''
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    try {
      const asString = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString()
      captured += asString
      if (captured.length > MAX_STDERR_CAPTURE) {
        captured = captured.slice(-MAX_STDERR_CAPTURE)
      }
    } catch {
      // ignore — stderr capture is best-effort
    }

    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  return () => captured
}
