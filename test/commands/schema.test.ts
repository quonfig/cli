import {expect, test} from '@oclif/test'

describe('schema', () => {
  test
    .command(['schema', 'my.schema', '--get'])
    .catch((error) => {
      expect(error.message).to.contain('temporarily disabled')
      expect(error.message).to.contain('plain JSON Schema documents')
    })
    .it('fails with a clear migration fence', () => {
      // Error assertion done in catch block
    })

  test
    .command(['schema', 'new.schema', '--set-zod=z.string()'])
    .catch((error) => {
      expect(error.message).to.contain('temporarily disabled')
      expect(error.message).to.contain('first-class schema-file API')
    })
    .it('does not allow legacy schema writes', () => {
      // Error assertion done in catch block
    })
})
