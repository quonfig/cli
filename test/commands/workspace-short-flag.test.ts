import {expect} from 'chai'

import Init from '../../src/commands/init.js'
import Migrate from '../../src/commands/migrate.js'
import Pull from '../../src/commands/pull.js'
import Push from '../../src/commands/push.js'

// qfg-qdcb: `-w` is a short alias for `--workspace` on every APICommand-derived
// command (and `generate`), but was missing on these four BaseCommand-derived
// commands that declare their own `workspace` flag. Keep the alias uniform.
describe('qfg-qdcb: -w short alias for --workspace', () => {
  const commands: Array<[string, {flags: {workspace?: {char?: string}}}]> = [
    ['push', Push],
    ['pull', Pull],
    ['init', Init],
    ['migrate', Migrate],
  ]

  for (const [name, command] of commands) {
    it(`${name} maps -w to --workspace`, () => {
      expect(command.flags.workspace, `${name} should declare a --workspace flag`).to.exist
      expect(command.flags.workspace?.char, `${name} --workspace should have char 'w'`).to.equal('w')
    })
  }
})
