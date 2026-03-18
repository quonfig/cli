import {Flags} from '@oclif/core'

const secretFlags = (secretDescription: string) => ({
  secret: Flags.boolean({default: false, description: secretDescription}),
  'secret-key-name': Flags.string({
    default: 'quonfig.secrets.encryption.key',
    description: 'name of the secret key to use for encryption/decryption',
  }),
})

export type Secret = {
  keyName: string
  selected: boolean
}

export const parsedSecretFlags = (flags: {secret: boolean; 'secret-key-name': string}): Secret => ({
  keyName: flags['secret-key-name'],
  selected: flags.secret,
})

export default secretFlags
