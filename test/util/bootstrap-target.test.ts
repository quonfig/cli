/**
 * `qfg workspace bootstrap` names the workspace it is about to push to, and
 * refuses when the directory's own pin says otherwise. Both come from the
 * same facts the resolver used, so the prompt cannot name one workspace
 * while the push lands in another (qfg-8p8i).
 */

import {expect} from 'chai'

import {bootstrapPinMismatch, describeBootstrapTarget} from '../../src/util/bootstrap-target.js'

const WS_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_ID = '99999999-8888-7777-6666-555555555555'
const profile = {
  workspace: WS_ID,
  workspaceName: 'Acme Production',
  workspaceSlug: 'prod',
  organizationSlug: 'acme',
}

describe('bootstrap: naming the target workspace', () => {
  it('names the QUONFIG_WORKSPACE override when that chose the target', () => {
    const name = describeBootstrapTarget({
      envOverride: 'other-org/other-ws',
      pin: {orgSlug: 'acme', workspaceSlug: 'prod'},
      profile,
      workspaceId: OTHER_ID,
    })
    expect(name).to.equal('other-org/other-ws')
  })

  it("names the directory's pin when that chose the target", () => {
    const name = describeBootstrapTarget({
      envOverride: undefined,
      pin: {orgSlug: 'acme', workspaceSlug: 'staging'},
      profile,
      workspaceId: OTHER_ID,
    })
    expect(name).to.equal('acme/staging')
  })

  it('names the active profile only when the profile IS the resolved workspace', () => {
    const name = describeBootstrapTarget({envOverride: undefined, pin: undefined, profile, workspaceId: WS_ID})
    expect(name).to.equal('acme/prod')
  })

  it('falls back to the workspace id rather than a profile that points elsewhere', () => {
    const name = describeBootstrapTarget({envOverride: undefined, pin: undefined, profile, workspaceId: OTHER_ID})
    expect(name).to.equal(OTHER_ID)
  })

  it('uses the profile display name when it has no slug', () => {
    const name = describeBootstrapTarget({
      envOverride: undefined,
      pin: undefined,
      profile: {workspace: WS_ID, workspaceName: 'Acme Production'},
      workspaceId: WS_ID,
    })
    expect(name).to.equal('Acme Production')
  })
})

describe("bootstrap: the directory's pin must match the workspace being pushed to", () => {
  it('is silent with no pin', () => {
    expect(bootstrapPinMismatch(undefined, 'prod')).to.equal(undefined)
  })

  it('is silent when the pin names the backend workspace', () => {
    expect(bootstrapPinMismatch({orgSlug: 'acme', workspaceSlug: 'prod'}, 'prod')).to.equal(undefined)
  })

  it('refuses, naming both sides, when the pin names another workspace', () => {
    const message = bootstrapPinMismatch({orgSlug: 'acme', workspaceSlug: 'prod'}, 'staging')
    expect(message).to.be.a('string')
    expect(message).to.contain('acme/prod')
    expect(message).to.contain('staging')
    expect(message).to.contain('QUONFIG_WORKSPACE')
  })
})
