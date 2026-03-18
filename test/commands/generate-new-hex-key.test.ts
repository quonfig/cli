import {expect, test} from '@oclif/test'

describe('generate-new-hex-key', () => {
  test
    .stdout()
    .command(['generate-new-hex-key'])
    .it('generates a new hex key', (ctx) => {
      expect(ctx.stdout.trim().length).to.eq(64)
    })

  test
    .stdout()
    .command(['generate-new-hex-key', '--json'])
    .it('generates JSON output with a new key', (ctx) => {
      const json = JSON.parse(ctx.stdout)
      expect(json.key.length).to.eq(64)
    })
})
