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
