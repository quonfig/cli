import {password} from '@inquirer/prompts'
import {ux} from '@oclif/core'

/** Streams for the masked prompt; tests pass their own instead of the TTY. */
export type PromptContext = {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

/**
 * Prompt for a string.
 *
 * `mask: true` (secret values, qfg-38lp) never echoes what is typed: each
 * character shows as `*`. It uses @inquirer/prompts' `password`, which reads
 * through readline with a muted output stream. oclif's `ux.prompt({type:
 * 'mask'})` was used before and was not safe: it wrote each typed character
 * and only redrew `*` after Enter (so the plaintext stayed in scrollback and
 * terminal logs), and it hung when a paste delivered "value\r" in one chunk.
 */
const getString = async ({
  allowBlank,
  context,
  mask,
  message,
}: {
  allowBlank: boolean
  context?: PromptContext
  mask?: boolean
  message: string
}): Promise<string> => {
  if (mask) {
    return password(
      {
        mask: '*',
        message,
        validate: (value: string) => allowBlank || value.length > 0 || 'A value is required',
      },
      context,
    )
  }

  return ux.prompt(message, {required: !allowBlank})
}

export default getString
