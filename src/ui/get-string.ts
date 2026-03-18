import {ux} from '@oclif/core'

const getString = async ({allowBlank, message}: {allowBlank: boolean; message: string}) => {
  const options: ux.IPromptOptions = {
    required: !allowBlank,
  }

  return ux.prompt(message, options)
}

export default getString
