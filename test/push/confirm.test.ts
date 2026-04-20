import {expect} from 'chai'
import {PassThrough} from 'node:stream'

import {confirmTypedSlug, confirmYesNo} from '../../src/push/confirm.js'

// Build an input/output pair backed by PassThrough streams. The caller writes
// whatever the "user" would type into input (with a trailing newline to commit
// the line), and output captures anything the prompt wrote. No TTY needed.
const makeIO = () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const outputChunks: string[] = []
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString('utf8')))
  return {
    get captured() {
      return outputChunks.join('')
    },
    input,
    output,
  }
}

describe('push/confirm', () => {
  describe('confirmYesNo', () => {
    it('returns true for "y\\n"', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('y\n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('returns true for "Y\\n"', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('Y\n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('returns true for "yes\\n"', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('yes\n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('returns false for "\\n" (bare Enter, default-no)', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('returns false for "n\\n"', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('n\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('returns false for "garbage\\n"', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('garbage\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('writes the prompt verbatim to the output stream', async () => {
      const io = makeIO()
      const p = confirmYesNo('Proceed? [y/N] ', {input: io.input, output: io.output})
      io.input.write('y\n')
      io.input.end()
      await p
      expect(io.captured).to.include('Proceed? [y/N] ')
    })
  })

  describe('confirmTypedSlug', () => {
    it('returns true when the user types the exact slug', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.write('acme-prod\n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('returns false for a mismatched slug', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.write('not-acme\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('trims trailing whitespace before comparing', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.write('acme-prod  \n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('is case-sensitive', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.write('ACME-PROD\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('returns false on empty input', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.write('\n')
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('returns false on EOF without any line', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        output: io.output,
      })
      io.input.end()
      expect(await p).to.equal(false)
    })

    it('re-prompts up to maxAttempts times and succeeds on a later match', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        maxAttempts: 3,
        output: io.output,
      })
      io.input.write('wrong\n')
      io.input.write('also-wrong\n')
      io.input.write('acme-prod\n')
      io.input.end()
      expect(await p).to.equal(true)
    })

    it('returns false after all maxAttempts are exhausted', async () => {
      const io = makeIO()
      const p = confirmTypedSlug('acme-prod', 'Type the workspace slug: ', {
        input: io.input,
        maxAttempts: 2,
        output: io.output,
      })
      io.input.write('wrong\n')
      io.input.write('still-wrong\n')
      io.input.end()
      expect(await p).to.equal(false)
    })
  })
})
