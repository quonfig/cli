import {expect} from 'chai'

import {decrypt} from '../../src/util/encryption.js'

describe('encryption utils', () => {
  describe('decrypt', () => {
    // Test encrypted value from SDK - 'test-secret' encrypted with the key below
    const encryptedValue = '652cf03ad4e252bb9b69c9--03bbdb754d1923b2a3c5bfc3--ebb8c20805482ce013b1fd68cad57d69'
    const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' // 64 char hex key
    const plaintext = 'test-secret'

    it('should decrypt an encrypted value with the correct key', () => {
      const result = decrypt(encryptedValue, encryptionKey)
      expect(result).to.equal(plaintext)
    })

    it('should throw error for invalid key length', () => {
      expect(() => decrypt(encryptedValue, 'short-key')).to.throw('Invalid key length')
    })

    it('should throw error for invalid encrypted string format', () => {
      expect(() => decrypt('invalid-format', encryptionKey)).to.throw(
        'Invalid encrypted string. Must contain encrypted data, IV, and auth tag.',
      )
    })

    it('should handle empty string encryption', () => {
      const emptyEncrypted = '----'
      const result = decrypt(emptyEncrypted, encryptionKey)
      expect(result).to.equal('')
    })

    it('should throw error for missing parts', () => {
      // Empty first part makes it invalid
      expect(() => decrypt('part1--part2', encryptionKey)).to.throw('Invalid encrypted string')
    })

    it('should throw error for authentication tag verification failure', () => {
      // Modified encrypted string with wrong tag - using zeros for the tag part
      const badEncrypted = '652cf03ad4e252bb9b69c9--03bbdb754d1923b2a3c5bfc3--00000000000000000000000000000000'
      expect(() => decrypt(badEncrypted, encryptionKey)).to.throw()
    })
  })
})
