import {createDecipheriv} from 'node:crypto'

const SEPARATOR: string = '--'
const KEY_LENGTH = 32 // 32 bytes for AES-256
const TAG_LENGTH = 16 // 16 bytes for GCM tag

/**
 * Decrypts an encrypted config value
 * Based on @quonfig/node/src/encryption.ts
 * @param {string} encryptedString - The encrypted string in format: encryptedData--IV--authTag
 * @param {string} keyStringHex - The encryption key as a 64-character hex string
 * @returns {string} The decrypted plaintext value
 */
export function decrypt(encryptedString: string, keyStringHex: string): string {
  if (keyStringHex.length !== KEY_LENGTH * 2) {
    throw new Error(`Invalid key length. Key must be a ${KEY_LENGTH * 2}-character hex string.`)
  }

  const parts = encryptedString.split(SEPARATOR)

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string. Must contain encrypted data, IV, and auth tag.')
  }

  const encryptedDataPart = parts[0]
  const ivPart = parts[1]
  const authTagPart = parts[2]

  if (encryptedDataPart === undefined || ivPart === undefined || authTagPart === undefined) {
    throw new Error('Invalid encrypted string. All parts must be defined.')
  }

  if (encryptedDataPart === '') {
    return ''
  }

  const key = Buffer.from(keyStringHex, 'hex')
  const encryptedData = Buffer.from(encryptedDataPart, 'hex')
  const iv = Buffer.from(ivPart, 'hex')
  const authTag = Buffer.from(authTagPart, 'hex')

  const decipher = createDecipheriv('aes-256-gcm', key, iv, {authTagLength: TAG_LENGTH})

  try {
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Authentication tag verification failed')
  }
}
