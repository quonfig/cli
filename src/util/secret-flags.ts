import {Flags} from '@oclif/core'

const secretFlags = (secretDescription: string) => ({
  keyset: Flags.string({
    description:
      'keyset to encrypt a secret to: a QUONFIG_KEYSET* name from quonfig.json. Needed only when the workspace has several and there is no current value to keep the keyset of',
    helpValue: 'QUONFIG_KEYSET_NAME',
  }),
  secret: Flags.boolean({default: false, description: secretDescription}),
  'secret-key-name': Flags.string({
    description: 'no longer used: secrets are encrypted to a keyset from quonfig.json (see --keyset)',
  }),
})

/**
 * Printed once when --secret-key-name is passed without --secret (with
 * --secret it is an error). Not oclif's `deprecated`, which warns on every
 * parse: three times per command.
 */
export const SECRET_KEY_NAME_NOTE =
  'Note: --secret-key-name no longer applies: qf1 secrets are encrypted to a keyset (--keyset).'

export type Secret = {
  /** True when --secret-key-name was passed (an error with a qf1 secret, plan Q4). */
  keyNameGiven: boolean
  keyset?: string
  selected: boolean
}

export const parsedSecretFlags = (flags: {keyset?: string; secret: boolean; 'secret-key-name'?: string}): Secret => ({
  keyNameGiven: flags['secret-key-name'] !== undefined,
  keyset: flags.keyset,
  selected: flags.secret,
})

export default secretFlags
