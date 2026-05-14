/**
 * Parsers for `qfg run` env-var → config-key mappings.
 *
 * Two callers, one grammar:
 *   - `--env VAR=key.path`  (inline)
 *   - `--env-file=PATH`     (one VAR=key.path per line)
 *
 * Grammar choices that are intentionally narrow:
 *   - Separator is `=`, not `:`. Matches `docker -e VAR=value` muscle memory.
 *     A line like `VAR:key.path` is rejected, not silently re-interpreted.
 *   - Split on the FIRST `=` only, so future config keys can theoretically
 *     contain `=` (rare, but cheap to support).
 *   - VAR side trimmed; key side trimmed once (whitespace inside the key
 *     is preserved if it's somehow legal — but we don't go out of our way).
 *   - Env files: blank lines and `#` comments are skipped. Errors include
 *     the 1-based line number so users can `vim +N file.env` to the spot.
 */

export interface RunEnvSpec {
  configKey: string
  varName: string
}

const splitOnFirstEquals = (raw: string): [string, string] | undefined => {
  const idx = raw.indexOf('=')
  if (idx === -1) return undefined
  return [raw.slice(0, idx), raw.slice(idx + 1)]
}

export const parseInlineEnvSpec = (raw: string): RunEnvSpec => {
  const split = splitOnFirstEquals(raw)
  if (!split) {
    throw new Error(`Invalid --env value "${raw}": expected VAR=key.path`)
  }

  const varName = split[0].trim()
  const configKey = split[1].trim()

  if (varName === '') {
    throw new Error(`Invalid --env value "${raw}": empty VAR name (left of =)`)
  }

  if (configKey === '') {
    throw new Error(`Invalid --env value "${raw}": empty config key (right of =)`)
  }

  return {varName, configKey}
}

export const parseEnvFileContents = (contents: string): RunEnvSpec[] => {
  const out: RunEnvSpec[] = []
  let lineNumber = 0

  for (const raw of contents.split('\n')) {
    lineNumber += 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    try {
      out.push(parseInlineEnvSpec(trimmed))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${detail} (line ${lineNumber})`)
    }
  }

  return out
}
