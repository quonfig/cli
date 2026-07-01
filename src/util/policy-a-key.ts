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
 *     and `qfg verify`).
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
  return null
}
