import {Flags, ux} from '@oclif/core'

import isInteractive from '../util/is-interactive.js'

export const confirmFlag = {confirm: Flags.boolean({description: 'confirm without prompt'})}

const getConfirmation = async ({
  flags,
  message,
}: {
  flags: {confirm?: boolean; interactive?: boolean}
  message: string
}): Promise<boolean> => {
  if (flags.confirm) return true

  if (!isInteractive(flags)) {
    throw new Error(
      'Cannot prompt for confirmation in a non-interactive context. Pass --confirm to skip the confirmation prompt.',
    )
  }

  return ux.confirm(message)
}

export default getConfirmation
