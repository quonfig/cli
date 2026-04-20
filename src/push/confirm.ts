// Thin prompt primitives for `qfg push` Guard 3.
//
// Two levels of confirmation:
//
//   confirmYesNo       -- standard y/N. Default NO. Bare Enter is a no.
//   confirmTypedSlug   -- user has to type the slug EXACTLY. Strict string
//                         equality (trailing whitespace trimmed). Case-sensitive.
//
// Both take injectable input/output streams so tests can drive them with
// in-memory PassThrough streams. Defaults are process.stdin / process.stdout.
//
// No business logic, no diff math, no network. Callers construct the prompt
// text (including the "[y/N]" hint); this module prints it verbatim.

import * as readline from 'node:readline'

type StreamOpts = {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

type TypedSlugOpts = {
  maxAttempts?: number
} & StreamOpts

// Wrap a readline.Interface in a queued line reader. Because readline emits
// 'line' events as data arrives (not only when we ask for one), a naive
// once('line', ...) / off('line', ...) between attempts can miss a line that
// was already emitted before we re-registered. Instead we buffer every line
// as it arrives and hand them out FIFO. If the stream closes with no pending
// line, readLine() resolves undefined.
type LineReader = {
  close(): void
  readLine(): Promise<string | undefined>
}

const makeLineReader = (rl: readline.Interface): LineReader => {
  const lines: string[] = []
  let closed = false
  let pending: {resolve: (value: string | undefined) => void} | null = null

  rl.on('line', (line: string) => {
    if (pending) {
      const p = pending
      pending = null
      p.resolve(line)
      return
    }

    lines.push(line)
  })

  rl.on('close', () => {
    closed = true
    if (pending) {
      const p = pending
      pending = null
      // eslint-disable-next-line unicorn/no-useless-undefined
      p.resolve(undefined)
    }
  })

  return {
    close() {
      rl.close()
    },
    readLine(): Promise<string | undefined> {
      if (lines.length > 0) {
        return Promise.resolve(lines.shift())
      }

      if (closed) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return Promise.resolve(undefined)
      }

      return new Promise<string | undefined>((resolve) => {
        pending = {resolve}
      })
    },
  }
}

const YES_ANSWERS = new Set(['y', 'Y', 'yes'])

// Standard confirmation. Returns true only for 'y' / 'Y' / 'yes' (exact, after
// trimming trailing whitespace). Anything else -- bare Enter, 'n', garbage,
// EOF -- is false. Default is NO.
export async function confirmYesNo(prompt: string, opts: StreamOpts = {}): Promise<boolean> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const rl = readline.createInterface({input, output, terminal: false})
  const reader = makeLineReader(rl)
  try {
    output.write(prompt)
    const line = await reader.readLine()
    if (line === undefined) return false

    // readline strips the trailing newline, but be defensive against CRLF and
    // trailing spaces.
    const trimmed = line.replace(/\s+$/, '')
    return YES_ANSWERS.has(trimmed)
  } finally {
    reader.close()
  }
}

// Typed-slug confirmation. Returns true only if the user types expectedSlug
// EXACTLY (case-sensitive) within maxAttempts tries. Trailing whitespace is
// trimmed before comparison; leading whitespace is NOT -- the plan says "have
// to type the slug exactly". Empty input / EOF / mismatch all count as a
// failed attempt.
//
// Default maxAttempts = 1 (plan: "have to type the slug exactly" -- one try
// is sufficient).
export async function confirmTypedSlug(
  expectedSlug: string,
  prompt: string,
  opts: TypedSlugOpts = {},
): Promise<boolean> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const maxAttempts = opts.maxAttempts ?? 1
  const rl = readline.createInterface({input, output, terminal: false})
  const reader = makeLineReader(rl)
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      output.write(prompt)
      // eslint-disable-next-line no-await-in-loop
      const line = await reader.readLine()
      if (line === undefined) return false

      const trimmed = line.replace(/\s+$/, '')
      if (trimmed === expectedSlug) return true
    }

    return false
  } finally {
    reader.close()
  }
}
