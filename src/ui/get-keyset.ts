import {select} from '@inquirer/prompts'

import type {KeysetPromptOption} from '../secrets/choose-keyset.js'
import type {PromptContext} from './get-string.js'

/** One line of the keyset prompt (plan 3.2 rule 5): name, write key fingerprint, what this machine holds. */
export const keysetChoiceLabel = (option: KeysetPromptOption, width: number): string =>
  `${option.name.padEnd(width)}  writes use ${option.writeFingerprint || '--------'}   ${option.annotation}`

/** Ask which keyset a new secret value is encrypted to. Only names, fingerprints and annotations are shown. */
const getKeyset = async (options: KeysetPromptOption[], context?: PromptContext): Promise<string> => {
  const width = Math.max(...options.map((o) => o.name.length))
  return select(
    {
      choices: options.map((o) => ({name: keysetChoiceLabel(o, width), value: o.name})),
      message: 'Encrypt with which keyset?',
    },
    context,
  )
}

export default getKeyset
