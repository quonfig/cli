import {type LegacyChange, type MigrationSource, NotYetImplementedError, type QuonfigFile} from '../source.js'

const SOURCE_NAME = 'launchdarkly'

export const launchdarklySource: MigrationSource = {
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
