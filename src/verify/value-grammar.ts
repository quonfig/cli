/**
 * The ONE value grammar for durations (qfg-2agi.3) and int/double input
 * (qfg-2agi.23), shared by qfg create, set-default, override and verify
 * (qfg-e87r.30). util/coerce.ts re-exports it.
 *
 * SELF-CONTAINED ON PURPOSE: no imports. It lives under src/verify/ because the
 * standalone qfg-verify pre-receive hook (app-gitea Dockerfile) is built from
 * this directory alone.
 */

// The ONE duration grammar (qfg-2agi.29), shared by qfg create, set-default,
// override and verify. Fixture of record: integration-test-data
// tests/duration/grammar.yaml (test/util/duration-grammar.test.ts holds this
// function to it).
//
//   ^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$
//
// plus: at least one component, no dangling T, a fraction only on S with at
// most 9 digits, total magnitude <= P36500D. [0-9] (not \d) and the whole
// string anchored so ports to other regex engines stay strict.
// JS \d is already ASCII-only; [0-9] is kept so a copy into Python/.NET is safe.
/* eslint-disable unicorn/better-regex */
const ISO_DURATION_PATTERN =
  /^P(?:(?<d>[0-9]+)D)?(?:T(?:(?<h>[0-9]+)H)?(?:(?<m>[0-9]+)M)?(?:(?<s>[0-9]+)(?:\.(?<f>[0-9]{1,9}))?S)?)?$/
/* eslint-enable unicorn/better-regex */

export const DURATION_FORMAT_HINT =
  'Expected an ISO 8601 duration such as PT30S, PT5M, PT1H30M or P1DT6H (days, hours, minutes, seconds; a fraction only on seconds; at most P36500D).'

const NANOS_PER_SECOND = 1_000_000_000n
const MAX_DURATION_NANOS = 36_500n * 86_400n * NANOS_PER_SECOND

export const isValidIsoDuration = (value: string): boolean => {
  const match = ISO_DURATION_PATTERN.exec(value)
  if (!match?.groups) return false
  const {d, f, h, m, s} = match.groups
  // At least one component; a T must be followed by at least one of H/M/S.
  if (d === undefined && h === undefined && m === undefined && s === undefined) return false
  if (value.includes('T') && h === undefined && m === undefined && s === undefined) return false
  // Exact integer arithmetic: huge digit strings cannot overflow past the cap.
  const nanos =
    (BigInt(d ?? 0) * 86_400n + BigInt(h ?? 0) * 3600n + BigInt(m ?? 0) * 60n + BigInt(s ?? 0)) * NANOS_PER_SECOND +
    BigInt((f ?? '').padEnd(9, '0'))
  return nanos <= MAX_DURATION_NANOS
}

// The ONE int/double input grammar (qfg-2agi.23), shared by qfg create and
// set-default. Strict whole-string matches with ASCII digits only: no
// surrounding whitespace, no hex, no trailing junk ('12abc'), no NaN/Infinity.
// An int must stay within +/-(2^53-1) because it is written as a JSON number
// and anything larger silently loses precision. Returns undefined when the
// input is not valid.
/* eslint-disable unicorn/better-regex */
const INT_PATTERN = /^-?[0-9]+$/
const DOUBLE_PATTERN = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/
/* eslint-enable unicorn/better-regex */

export const parseIntValue = (value: string): number | undefined => {
  if (!INT_PATTERN.test(value)) return undefined
  const int = Number(value)
  return Number.isSafeInteger(int) ? int : undefined
}

export const parseDoubleValue = (value: string): number | undefined => {
  if (!DOUBLE_PATTERN.test(value)) return undefined
  const double = Number(value)
  return Number.isFinite(double) ? double : undefined
}

// The ONE timestamp grammar for PROP_BEFORE / PROP_AFTER (qfg-goi1.5 R5),
// identical on the criterion and context sides in every SDK: a JSON number
// (epoch ms), an all-digit string (epoch ms), or RFC3339 with an uppercase T
// and a Z or numeric offset (fractional seconds allowed). Date-only,
// offset-less and free-form strings are not timestamps.
/* eslint-disable unicorn/better-regex */
const RFC3339_PATTERN =
  /^(?<y>[0-9]{4})-(?<mo>[0-9]{2})-(?<d>[0-9]{2})T(?<h>[0-9]{2}):(?<mi>[0-9]{2}):(?<s>[0-9]{2})(?:\.[0-9]+)?(?:Z|[+-](?<oh>[0-9]{2}):(?<om>[0-9]{2}))$/
/* eslint-enable unicorn/better-regex */

export const TIMESTAMP_FORMAT_HINT =
  'Expected epoch milliseconds (a number or an all-digit string) or an RFC3339 timestamp with Z or an offset, such as 2025-01-01T00:00:00Z or 2025-01-01T09:00:00+09:00.'

export const isValidRfc3339 = (value: string): boolean => {
  const g = RFC3339_PATTERN.exec(value)?.groups
  if (!g) return false
  const [y, mo, d, h, mi, s] = [g.y, g.mo, g.d, g.h, g.mi, g.s].map(Number)
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59) return false
  if (g.oh !== undefined && (Number(g.oh) > 23 || Number(g.om) > 59)) return false
  return true
}

export const isValidTimestamp = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return parseIntValue(value) !== undefined || isValidRfc3339(value)
}

// The ONE version grammar for PROP_SEMVER_* (qfg-goi1.5 R4 + Q5): SemVer 2.0
// (no leading zeros, optional prerelease and build on a full x.y.z), plus the
// abbreviated forms "x" and "x.y", read as x.0.0 and x.y.0. A "v" prefix is
// not a version.
const NUM = '(?:0|[1-9][0-9]*)'
const PRE_ID = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
const BUILD_ID = '[0-9a-zA-Z-]+'
const SEMVER_PATTERN = new RegExp(
  `^${NUM}(?:\\.${NUM}(?:\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?)?)?$`,
)

export const SEMVER_FORMAT_HINT =
  'Expected a SemVer 2.0 version such as 4.0.18, 1.0.0-beta.1 or 1.0.0+build.5, or an abbreviated 4 / 4.1 (read as 4.0.0 / 4.1.0). No "v" prefix.'

export const isValidSemver = (value: unknown): boolean => typeof value === 'string' && SEMVER_PATTERN.test(value)

// IN_INT_RANGE (qfg-goi1.5 R3): an object with integer start and/or end (at
// least one), each a safe integer or an all-digit string (the proto int64 JSON
// form). Range is [start, end); a missing bound is unbounded.
export const INT_RANGE_FORMAT_HINT =
  'Expected {"start": <int>, "end": <int>} with at least one bound; the range is [start, end) and a missing bound is unbounded.'

export const isValidIntRange = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((k) => k !== 'start' && k !== 'end')) return false
  return Object.values(value).every((bound) =>
    typeof bound === 'number'
      ? Number.isSafeInteger(bound)
      : typeof bound === 'string' && parseIntValue(bound) !== undefined,
  )
}
