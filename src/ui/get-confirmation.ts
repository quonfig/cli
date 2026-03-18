import {Flags, ux} from '@oclif/core'

export const confirmFlag = {confirm: Flags.boolean({description: 'confirm without prompt'})}

const getConfirmation = async ({flags, message}: {flags: {confirm?: boolean}; message: string}): Promise<boolean> =>
  flags.confirm || ux.confirm(message)

export default getConfirmation
