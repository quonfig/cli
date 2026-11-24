/**
 * Which keyset a secret write encrypts to (plan 3.2, spec 7 writer rules,
 * decision 34). Bead qfg-mol-hle PR 2.
 */
import {expect} from 'chai'

import {
  type KeysetPromptOption,
  KeysetChoiceError,
  chooseKeyset,
  movedKeysetNotice,
} from '../../src/secrets/choose-keyset.js'
import {formatPublicKeyEntry} from '../../src/secrets/qf1.js'
import {readWorkspaceKeysets} from '../../src/secrets/workspace-keysets.js'
import {quonfigJson, testKey} from './plumbing-fixtures.js'

const k1 = testKey()
const k2 = testKey()
const k3 = testKey()
const one = readWorkspaceKeysets(quonfigJson({QUONFIG_KEYSET: {publicKeys: [k1.publicEntry]}})).keysets
const two = readWorkspaceKeysets(
  quonfigJson({
    QUONFIG_KEYSET: {publicKeys: [k1.publicEntry]},
    QUONFIG_KEYSET_PROD: {publicKeys: [k2.publicEntry, k3.publicEntry]},
  }),
).keysets

const noPrompt = async (): Promise<string> => {
  throw new Error('the prompt must not be shown')
}

async function errorOf(p: Promise<unknown>): Promise<KeysetChoiceError> {
  try {
    await p
  } catch (error) {
    expect(error).to.be.instanceOf(KeysetChoiceError)
    return error as KeysetChoiceError
  }

  return expect.fail('expected a KeysetChoiceError')
}

describe('chooseKeyset (plan 3.2, qfg-mol-hle)', () => {
  it('no keysets: error, even with --keyset', async () => {
    for (const flagKeyset of [undefined, 'QUONFIG_KEYSET']) {
      const err = await errorOf(chooseKeyset({flagKeyset, interactive: true, keysets: [], prompt: noPrompt}))
      expect(err.code).to.equal('no_keysets')
      expect(err.message).to.include('This workspace has no keysets')
    }
  })

  it('--keyset wins over the only keyset, the inherited one and the prompt', async () => {
    const c = await chooseKeyset({
      flagKeyset: 'QUONFIG_KEYSET_PROD',
      inherited: 'QUONFIG_KEYSET_PROD',
      interactive: true,
      keysets: two,
      prompt: noPrompt,
    })
    expect(c).to.deep.equal({
      fingerprint: k2.fingerprint,
      keyset: 'QUONFIG_KEYSET_PROD',
      recipient: k2.publicEntry,
      source: 'flag',
    })
  })

  it('the write key is the FIRST public key of the keyset', async () => {
    const c = await chooseKeyset({flagKeyset: 'QUONFIG_KEYSET_PROD', interactive: false, keysets: two})
    expect(c.recipient).to.equal(k2.publicEntry)
    expect(c.recipient).to.not.equal(k3.publicEntry)
  })

  it('--keyset must be declared in quonfig.json, and the error lists the declared ones', async () => {
    const err = await errorOf(chooseKeyset({flagKeyset: 'QUONFIG_KEYSET_CI', interactive: false, keysets: two}))
    expect(err.code).to.equal('unknown_keyset')
    expect(err.message).to.equal(
      'QUONFIG_KEYSET_CI is not a keyset in this workspace; declared: QUONFIG_KEYSET, QUONFIG_KEYSET_PROD',
    )
  })

  it('--keyset with an invalid name: invalid_keyset_name, nothing read', async () => {
    for (const bad of ['HOME', 'QUONFIG_KEYSET_prod', 'QUONFIG_KEYSET_TEST\n']) {
      const err = await errorOf(chooseKeyset({flagKeyset: bad, interactive: false, keysets: two}))
      expect(err.code).to.equal('invalid_keyset_name')
    }
  })

  it('--keyset naming a keyset whose write key is invalid is refused with the place and reason', async () => {
    const topBit = new Uint8Array(32).fill(9)
    topBit[31] = 0x80
    const keysets = readWorkspaceKeysets(
      quonfigJson({QUONFIG_KEYSET: {publicKeys: [formatPublicKeyEntry(topBit), k1.publicEntry]}}),
    ).keysets
    const err = await errorOf(chooseKeyset({flagKeyset: 'QUONFIG_KEYSET', interactive: false, keysets}))
    expect(err.code).to.equal('unwritable_keyset')
    expect(err.message).to.include('quonfig.json secrets.keysets.QUONFIG_KEYSET.publicKeys[0]')
  })

  it('--keyset differing from the inherited keyset reports the move', async () => {
    const c = await chooseKeyset({
      flagKeyset: 'QUONFIG_KEYSET',
      inherited: 'QUONFIG_KEYSET_PROD',
      interactive: false,
      keysets: two,
    })
    expect(c.source).to.equal('flag')
    expect(c.movedFrom).to.equal('QUONFIG_KEYSET_PROD')
  })

  it('--keyset equal to the inherited keyset is not a move', async () => {
    const c = await chooseKeyset({
      flagKeyset: 'QUONFIG_KEYSET_PROD',
      inherited: 'QUONFIG_KEYSET_PROD',
      interactive: false,
      keysets: two,
    })
    expect(c).to.not.have.property('movedFrom')
  })

  it('an update inherits the existing keyset without prompting, even interactively', async () => {
    for (const interactive of [true, false]) {
      const c = await chooseKeyset({inherited: 'QUONFIG_KEYSET_PROD', interactive, keysets: two, prompt: noPrompt})
      expect(c).to.deep.include({keyset: 'QUONFIG_KEYSET_PROD', source: 'inherited'})
      expect(c).to.not.have.property('movedFrom')
    }
  })

  it('a stale inherited keyset that quonfig.json no longer declares is refused', async () => {
    const err = await errorOf(chooseKeyset({inherited: 'QUONFIG_KEYSET_OLD', interactive: true, keysets: two}))
    expect(err.code).to.equal('stale_inherited')
    expect(err.message).to.equal(
      'the current value is on QUONFIG_KEYSET_OLD, which quonfig.json no longer declares; pass --keyset',
    )
  })

  it('exactly one keyset declared: used without a prompt, interactive or not', async () => {
    for (const interactive of [true, false]) {
      const c = await chooseKeyset({interactive, keysets: one, prompt: noPrompt})
      expect(c).to.deep.equal({
        fingerprint: k1.fingerprint,
        keyset: 'QUONFIG_KEYSET',
        recipient: k1.publicEntry,
        source: 'only',
      })
    }
  })

  it('several keysets, interactive, nothing inherited: prompts with the annotations', async () => {
    let shown: KeysetPromptOption[] = []
    const c = await chooseKeyset({
      env: {QUONFIG_KEYSET: k1.privateEntry, QUONFIG_KEYSET_PROD: k3.privateEntry},
      interactive: true,
      keysets: two,
      async prompt(options) {
        shown = options
        return 'QUONFIG_KEYSET_PROD'
      },
    })
    expect(c).to.deep.include({keyset: 'QUONFIG_KEYSET_PROD', recipient: k2.publicEntry, source: 'prompt'})
    expect(shown).to.deep.equal([
      {
        annotation: 'this machine can also read it',
        name: 'QUONFIG_KEYSET',
        writeFingerprint: k1.fingerprint,
      },
      {
        annotation: `this machine has QUONFIG_KEYSET_PROD but not key ${k2.fingerprint}`,
        name: 'QUONFIG_KEYSET_PROD',
        writeFingerprint: k2.fingerprint,
      },
    ])
  })

  it('prompt annotations: not on this machine, and unreadable by entry position', async () => {
    let shown: KeysetPromptOption[] = []
    await chooseKeyset({
      env: {QUONFIG_KEYSET_PROD: `${k2.privateEntry},garbage`},
      interactive: true,
      keysets: two,
      async prompt(options) {
        shown = options
        return 'QUONFIG_KEYSET'
      },
    })
    expect(shown.map((o) => o.annotation)).to.deep.equal([
      'not on this machine',
      'QUONFIG_KEYSET_PROD here is unreadable (entry 2)',
    ])
  })

  it('a prompt answer that is not a declared keyset is refused', async () => {
    const err = await errorOf(
      chooseKeyset({interactive: true, keysets: two, prompt: async () => 'QUONFIG_KEYSET_OTHER'}),
    )
    expect(err.code).to.equal('unknown_keyset')
  })

  it('several keysets, non-interactive, nothing inherited, no --keyset: error listing names, never a guess', async () => {
    const err = await errorOf(chooseKeyset({interactive: false, keysets: two, prompt: noPrompt}))
    expect(err.code).to.equal('ambiguous')
    expect(err.message).to.equal('Choose a keyset with --keyset: QUONFIG_KEYSET, QUONFIG_KEYSET_PROD')
  })

  it('several keysets, interactive but no prompt available: error, never a guess', async () => {
    const err = await errorOf(chooseKeyset({interactive: true, keysets: two}))
    expect(err.code).to.equal('ambiguous')
  })

  it('the count is of quonfig.json keysets, not of the machine env (decision 34)', async () => {
    // Two declared keysets; the machine holds only one of them. Still ambiguous.
    const err = await errorOf(chooseKeyset({env: {QUONFIG_KEYSET: k1.privateEntry}, interactive: false, keysets: two}))
    expect(err.code).to.equal('ambiguous')
  })

  it('movedKeysetNotice wording', () => {
    expect(movedKeysetNotice('stripe.key', 'production', 'QUONFIG_KEYSET_A', 'QUONFIG_KEYSET_B')).to.equal(
      'Moving stripe.key (production) from QUONFIG_KEYSET_A to QUONFIG_KEYSET_B: runtimes that hold only QUONFIG_KEYSET_A will fail to read it.',
    )
  })
})
