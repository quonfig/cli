// eslint-disable-next-line import/default
import fuzzy from 'fuzzy'
import internalAutocomplete from 'inquirer-autocomplete-standalone'

import {green} from '../util/color.js'

const options = {
  post: '\u001B[0m',
  pre: '\u001B[31m',
}

const unformat = (str: string) => str.replaceAll(options.pre, '').replaceAll(options.post, '')

type Args = {
  message: string
  source: (() => string[]) | string[]
}

const autocomplete = async ({message, source}: Args) => {
  try {
    const result = await internalAutocomplete({
      message: green(message),
      async source(input: string | undefined) {
        const list = typeof source === 'function' ? source() : source

        // eslint-disable-next-line import/no-named-as-default-member
        return fuzzy.filter(input ?? '', list, options).map((el) => ({value: el.string}))
      },
    })

    return unformat(result)
  } catch {}

  return null
}

export default autocomplete
