import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'

import isInteractive from '../util/is-interactive.js'
import type {PromptContext} from './get-string.js'

export const confirmFlag = {confirm: Flags.boolean({description: 'confirm without prompt'})}

/**
 * Ask a yes/no question; Enter alone answers no.
 *
 * Uses @inquirer/prompts' `confirm`, which reads in raw mode. oclif's
 * `ux.confirm` read a cooked line, so under a pty the terminal echoed a stray
 * `^D` before the success line (qfg-r3a47).
 */
const getConfirmation = async ({
  context,
  flags,
  message,
}: {
  context?: PromptContext
  flags: {confirm?: boolean; interactive?: boolean}
  message: string
}): Promise<boolean> => {
  if (flags.confirm) return true

  // A caller-supplied context (tests) brings its own streams instead of the TTY.
  if (!context && !isInteractive(flags)) {
    throw new Error(
      'Cannot prompt for confirmation in a non-interactive context. Pass --confirm to skip the confirmation prompt.',
    )
  }

  return confirm({default: false, message}, context)
}

export default getConfirmation
