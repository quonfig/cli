import {ux} from '@oclif/core'

/**
 * Prompt for a string. `mask: true` (used for secret values, qfg-38lp) shows a
 * `*` per typed character instead of echoing the value.
 */
const getString = async ({allowBlank, mask, message}: {allowBlank: boolean; mask?: boolean; message: string}) => {
  const options: ux.IPromptOptions = {
    required: !allowBlank,
    ...(mask ? {type: 'mask' as const} : {}),
  }

  return ux.prompt(message, options)
}

export default getString
