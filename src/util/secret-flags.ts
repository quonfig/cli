import {Flags} from '@oclif/core'

/** The old-format key config `makeConfidentialValue` encrypted to (removed with it in qfg-8seuf.21). */
export const LEGACY_SECRET_KEY_NAME = 'quonfig.secrets.encryption.key'

const secretFlags = (secretDescription: string) => ({
  keyset: Flags.string({
    description:
      'keyset to encrypt a secret to: a QUONFIG_KEYSET* name from quonfig.json. Needed only when the workspace has several and there is no current value to keep the keyset of',
    helpValue: 'QUONFIG_KEYSET_NAME',
  }),
  secret: Flags.boolean({default: false, description: secretDescription}),
  'secret-key-name': Flags.string({
    deprecated: {message: '--secret-key-name no longer applies: qf1 secrets are encrypted to a keyset (--keyset)'},
    description: 'no longer used: secrets are encrypted to a keyset from quonfig.json (see --keyset)',
  }),
})

export type Secret = {
  keyName: string
  /** True when --secret-key-name was passed (an error with a qf1 secret, plan Q4). */
  keyNameGiven: boolean
  keyset?: string
  selected: boolean
}

export const parsedSecretFlags = (flags: {keyset?: string; secret: boolean; 'secret-key-name'?: string}): Secret => ({
  keyName: flags['secret-key-name'] ?? LEGACY_SECRET_KEY_NAME,
  keyNameGiven: flags['secret-key-name'] !== undefined,
  keyset: flags.keyset,
  selected: flags.secret,
})

export default secretFlags
