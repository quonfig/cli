// Stub — `qfg migrate --from flagsmith` is not yet wired up. Before replacing this with a real
// implementation, investigate:
//   - Flagsmith API shape: what the admin/REST API returns for features, segments, identities,
//     environments, and multivariate variations, and how that maps onto Quonfig's JSON schema.
//   - Delta/cursor support: whether Flagsmith exposes an audit-log or change-feed endpoint with a
//     stable cursor we can persist in `.qf/import-state.json` for re-runnable incremental
//     imports, or whether we have to full-reimport + diff on every run (as is likely for LD).
//   - Auth model: API key scopes (server-side vs. admin), org/project/environment hierarchy.
//   - Schema gaps: Flagsmith's identity overrides and segment rules vs. Quonfig's rule operators
//     — document any unsupported primitives the way `launchdarkly.README.md` does for LD.
import {type LegacyChange, type MigrationSource, NotYetImplementedError, type QuonfigFile} from '../source.js'

const SOURCE_NAME = 'flagsmith'

export const flagsmithSource: MigrationSource = {
  // eslint-disable-next-line require-yield
  async *fetchChanges(): AsyncIterable<LegacyChange> {
    throw new NotYetImplementedError(SOURCE_NAME, 'fetchChanges')
  },
  listEnvironments(): Promise<string[]> {
    throw new NotYetImplementedError(SOURCE_NAME, 'listEnvironments')
  },
  name: SOURCE_NAME,
  translate(): QuonfigFile[] {
    throw new NotYetImplementedError(SOURCE_NAME, 'translate')
  },
  validateAuth(): Promise<void> {
    throw new NotYetImplementedError(SOURCE_NAME, 'validateAuth')
  },
}
