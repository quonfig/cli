import {type LegacyChange, type MigrationSource, type QuonfigFile} from '../source.js'

const SOURCE_NAME = 'launch'

class PendingPortError extends Error {
  constructor(operation: string) {
    super(
      `launch source ${operation} is not yet wired — pending port of launch-migrator (see bead qfg-zfl.3).`,
    )
    this.name = 'PendingPortError'
  }
}

export const launchSource: MigrationSource = {
  // eslint-disable-next-line require-yield
  async *fetchChanges(): AsyncIterable<LegacyChange> {
    throw new PendingPortError('fetchChanges')
  },
  listEnvironments(): Promise<string[]> {
    throw new PendingPortError('listEnvironments')
  },
  name: SOURCE_NAME,
  translate(): QuonfigFile[] {
    throw new PendingPortError('translate')
  },
  validateAuth(): Promise<void> {
    throw new PendingPortError('validateAuth')
  },
}
