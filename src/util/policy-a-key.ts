/**
 * Policy A key rule, HARD-enforced at `qfg create` time client-side (qfg-6na9.2)
 * so a bad key fails fast before the network round-trip. This is a deliberate,
 * hand-kept mirror of app-quonfig `src/lib/domain/config-schemas.ts`
 * `PolicyAKeySchema` — the two MUST move together (see
 * project/plans/26-06-tighter-naming.md, "Decision: Policy A"):
 *
 *   - charset `^[A-Za-z0-9._-]+$` (uppercase IS allowed; case-insensitive
 *     collision is a separate verify/create-handler check, not here),
 *   - 1..200 chars (ASCII-only, so char length == byte length),
 *   - not the reserved key `"new"`,
 *   - no leading dot (a `.beta.json` config is silently skipped by the loader
 *     and `qfg verify`),
 *   - no trailing dot or space (silently stripped on Windows), and
 *   - the first dot-segment is not a Windows reserved device name (qfg-hbuy.6).
 *
 * NOTE the layering: this is the create boundary (hard). The general charset is
 * a *warning* in `qfg verify` (`src/verify/validate.ts`, qfg-6na9.5) during the
 * warn->error soak, and the FS-safety floor there is already hard (qfg-6na9.4).
 * Keep the messages aligned with app-quonfig's for a consistent UX.
 */
// Kept as the explicit char class (not the `[\w.-]` the linter suggests) so it
// is a byte-for-byte mirror of app-quonfig's PolicyAKeySchema and greppable
// across both sources of truth — see the module doc above.
// eslint-disable-next-line unicorn/better-regex
export const POLICY_A_KEY_RE = /^[A-Za-z0-9._-]+$/

/**
 * Windows reserved device names (qfg-hbuy.6). Byte-identical mirror of
 * app-quonfig `src/lib/domain/config-schemas.ts` `WINDOWS_RESERVED_DEVICE_NAME_RE`
 * and the qfg-verify hook's FS-safety floor (`src/verify/validate.ts`
 * `FS_SAFETY_FLOOR_CHECKS`). Matched case-insensitively against the FIRST
 * dot-segment of the key (`k.split('.')[0]`), because Windows treats
 * `con.anything` as the `con` device. So `con`, `CON`, and `com3.foo` are
 * rejected while `foo.con`, `com10`, and `console` are fine. The audit
 * (project/plans/26-07-policy-a-audit-findings.md) specifically wants these
 * checks byte-identical across enforcement points — keep the regex in sync.
 */
export const WINDOWS_RESERVED_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Returns a human-readable error message for a key that violates Policy A, or
 * `null` if the key is valid. First failing rule wins (matches the order Zod
 * evaluates the refinements in app-quonfig).
 */
export function policyAKeyError(key: string): string | null {
  if (key.length === 0) return 'Key is required'
  if (key.length > 200) return 'Key must be 200 characters or fewer'
  if (key === 'new') return 'Key cannot be "new"'
  if (!POLICY_A_KEY_RE.test(key)) return 'Key can only contain letters, numbers, dots, dashes, and underscores'
  if (key.startsWith('.')) return 'Key cannot start with a dot'
  // ── FS-safety floor parity with app-quonfig PolicyAKeySchema (qfg-hbuy.6) ──
  // The charset above already covers the hook's control-char and
  // Windows-reserved-char floor items; these two are the only floor items the
  // charset alone permits. Without them the UI/create boundary accepts the key
  // and the user gets a confusing 422 at push time instead of a clean error.
  if (/[ .]$/.test(key)) return 'Key cannot end with a dot or space'
  if (WINDOWS_RESERVED_DEVICE_NAME_RE.test(key.split('.')[0]!)) {
    return 'Key cannot use a Windows reserved device name (con, prn, aux, nul, com1-9, lpt1-9) before the first dot'
  }

  return null
}
