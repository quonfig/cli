/**
 * Shared verb: structured conversion-report accumulator.
 *
 * Part of the `quonfig-target/` verb library (plan §3.1, D1). Every
 * skip/drop/coerce path in a provider's `translate.ts` records a structured
 * entry here so it lands in `MIGRATION_REPORT.md` — nothing is silently
 * dropped (plan §5.4).
 *
 * The categories below are the LaunchDarkly v1 set; a second provider adds its
 * own categories. The accumulator itself is provider-independent.
 */

export type ConversionNoteCategory =
  /** A flag/segment that could not be converted at all. */
  | 'skipped-config'
  /** A rule dropped because a clause's operator has no v1 Quonfig mapping (D3). */
  | 'skipped-rule'
  /** An individual/context target converted to a leading PROP_IS_ONE_OF rule (lossy — plan §5.4). */
  | 'individual-target-as-rule'
  /** Prerequisites dropped — no cross-flag dependency operator in Quonfig v1. */
  | 'dropped-prerequisite'
  /** `privateAttributes` dropped — no Quonfig equivalent. */
  | 'dropped-private-attribute'
  /** Experiment rollout converted to plain weighted_values; seed/kind dropped. */
  | 'dropped-experiment-metadata'
  /** Maintainer metadata dropped — Quonfig authorship lives in git history. */
  | 'dropped-maintainer'
  /** `customProperties` dropped — report-only in v1 (D6). */
  | 'dropped-custom-properties'
  /**
   * `usingMobileKey:true` collapsed into Quonfig's single client-visibility bool,
   * but the flag is still client-visible because `usingEnvironmentId` is also true.
   * No action required — pure rollup noise.
   */
  | 'dropped-mobile-key-still-visible'
  /**
   * `usingMobileKey:true` but `usingEnvironmentId:false` — the flag was
   * mobile-only in LD and will no longer reach mobile clients after migration.
   * Must-fix before cutover.
   */
  | 'dropped-mobile-key-now-server-only'
  /** A percentage rollout that will re-bucket users post-migration (plan §5.4). */
  | 'rebucketed-rollout'
  /** A big/synced segment whose membership is not exportable via REST. */
  | 'unexportable-segment-membership'
  /** An AI Config enumerated but not emitted (out of v1 scope, D9). */
  | 'ai-config-skipped'

export interface ConversionNote {
  category: ConversionNoteCategory
  /** Human-readable detail — names the exact thing lost and why. */
  detail: string
  /** Source key the note is about (flag or segment key). */
  key: string
}

/**
 * Collects conversion notes during a migration run. A provider source holds
 * one instance, passes it to every `translate()` call, and surfaces its
 * contents through the `MigrationSource` reporting accessors.
 */
export class ConversionReport {
  private readonly notes: ConversionNote[] = []

  get size(): number {
    return this.notes.length
  }

  add(category: ConversionNoteCategory, key: string, detail: string): void {
    this.notes.push({category, detail, key})
  }

  /** All notes, in insertion order. */
  all(): ConversionNote[] {
    return [...this.notes]
  }

  /** Notes of one category, in insertion order. */
  byCategory(category: ConversionNoteCategory): ConversionNote[] {
    return this.notes.filter((n) => n.category === category)
  }

  isEmpty(): boolean {
    return this.notes.length === 0
  }

  reset(): void {
    this.notes.length = 0
  }
}
