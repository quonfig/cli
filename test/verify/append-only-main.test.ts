import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {hookVersion, runHookChecks} from '../../src/verify/standalone.js'

/**
 * qfg-jxml.21 — `main` is append-only (plan 2026-09-17-tree-derived-cache 5.6).
 *
 * Every update to refs/heads/main must have a NON-ZERO old oid that is an
 * ancestor of the new oid. A delete is rejected, a create (zero old oid) is
 * rejected, other refs stay rewritable. Two-key operator bypass; enforcement
 * gated by a per-repo allowlist env var that fails open to today's behaviour.
 */
describe('append-only main (qfg-jxml.21)', () => {
  const ZERO = '0'.repeat(40)
  const REPO = 'quonfig/our-config'

  type Fixture = {alt: string; bare: string; first: string; second: string}

  const tmpdirs: string[] = []

  after(() => {
    for (const dir of tmpdirs) fs.rmSync(dir, {force: true, recursive: true})
  })

  function writeConfig(dir: string, relPath: string, key: string): void {
    fs.mkdirSync(path.join(dir, path.dirname(relPath)), {recursive: true})
    fs.writeFileSync(
      path.join(dir, relPath),
      JSON.stringify({
        default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'x'}}]},
        environments: [],
        key,
        type: 'config',
        valueType: 'string',
        variants: [],
      }),
    )
  }

  /**
   * A real repo with a divergent history, cloned into a real BARE repo (what a
   * pre-receive hook actually runs against):
   *
   *   first --- second        (refs/heads/main)
   *      \
   *       ---- alt            (refs/heads/alt)
   */
  function makeFixture(): Fixture {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-ff-work-'))
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-ff-bare-'))
    tmpdirs.push(work, bare)

    const git = (...args: string[]) => execFileSync('git', args, {cwd: work, encoding: 'utf8'}).trim()
    git('init', '--quiet', '--initial-branch', 'main')
    git('config', 'user.email', 'test@quonfig.test')
    git('config', 'user.name', 'test')

    writeConfig(work, 'configs/first-key.json', 'first-key')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'first')
    const first = git('rev-parse', 'HEAD')

    writeConfig(work, 'configs/second-key.json', 'second-key')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'second')
    const second = git('rev-parse', 'HEAD')

    git('checkout', '--quiet', '-b', 'alt', first)
    writeConfig(work, 'configs/alt-key.json', 'alt-key')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'alt')
    const alt = git('rev-parse', 'HEAD')
    git('checkout', '--quiet', 'main')

    execFileSync('git', ['clone', '--bare', '--quiet', work, bare], {encoding: 'utf8'})
    return {alt, bare, first, second}
  }

  let fixture: Fixture
  before(() => {
    fixture = makeFixture()
  })

  type Env = Record<string, string | undefined>

  const enforcingEnv = (extra: Env = {}): Env => ({
    GITEA_REPO_NAME: 'our-config',
    GITEA_REPO_USER_NAME: 'quonfig',
    QUONFIG_HOOK_FF_ENFORCE: REPO,
    ...extra,
  })

  const bypassEnv = (extra: Env = {}): Env =>
    enforcingEnv({
      GIT_PUSH_OPTION_0: 'quonfig-rewrite=legal erasure qfg-1234',
      GIT_PUSH_OPTION_COUNT: '1',
      GITEA_PUSHER_NAME: 'quonfig-admin',
      QUONFIG_HOOK_OPERATOR: 'quonfig-admin',
      ...extra,
    })

  function run(refs: Array<{newOid: string; oldOid: string; refName: string}>, env: Env) {
    const out: string[] = []
    const err: string[] = []
    const code = runHookChecks(refs, {
      cwd: fixture.bare,
      env,
      log: (line: string) => out.push(line),
      logErr: (line: string) => err.push(line),
    })
    return {code, err: err.join('\n'), out}
  }

  const mainRef = (oldOid: string, newOid: string) => [{newOid, oldOid, refName: 'refs/heads/main'}]

  describe('the rule', () => {
    it('rejects a non-fast-forward push to main', () => {
      const {code, err} = run(mainRef(fixture.second, fixture.alt), enforcingEnv())
      expect(code, err).to.equal(1)
      expect(err).to.match(/append-only/i)
    })

    it('rejects a delete of main', () => {
      const {code, err} = run(mainRef(fixture.second, ZERO), enforcingEnv())
      expect(code, err).to.equal(1)
      expect(err).to.match(/delet/i)
    })

    it('rejects a create of main (zero old oid) without the bypass', () => {
      const {code, err} = run(mainRef(ZERO, fixture.second), enforcingEnv())
      expect(code, err).to.equal(1)
      expect(err).to.match(/creat/i)
    })

    it('accepts an ordinary fast-forward of main', () => {
      const {code, err} = run(mainRef(fixture.first, fixture.second), enforcingEnv())
      expect(code, err).to.equal(0)
      expect(err).to.equal('')
    })

    it('accepts a force-push to a non-main branch', () => {
      const {code, err} = run(
        [{newOid: fixture.alt, oldOid: fixture.second, refName: 'refs/heads/feature'}],
        enforcingEnv(),
      )
      expect(code, err).to.equal(0)
    })

    it('rejects the whole push when one ref in a batch rewrites main', () => {
      const {code} = run(
        [
          {newOid: fixture.alt, oldOid: fixture.second, refName: 'refs/heads/feature'},
          {newOid: fixture.alt, oldOid: fixture.second, refName: 'refs/heads/main'},
        ],
        enforcingEnv(),
      )
      expect(code).to.equal(1)
    })

    it('tells the customer what to do instead (rebase, forward restore, CLI upgrade)', () => {
      const {err} = run(mainRef(fixture.second, fixture.alt), enforcingEnv())
      expect(err, 'rebase').to.match(/rebase/i)
      expect(err, 'forward restore recipe').to.include('git restore --source=')
      expect(err, 'push after restore').to.include('qfg push')
      expect(err, 'bootstrap on an older CLI').to.match(/upgrade/i)
    })
  })

  describe('operator bypass (two keys, both required)', () => {
    it('accepts a rewrite of main with BOTH keys', () => {
      const {code, err} = run(mainRef(fixture.second, fixture.alt), bypassEnv())
      expect(code, err).to.equal(0)
    })

    it('logs the declared reason', () => {
      const {err} = run(mainRef(fixture.second, fixture.alt), bypassEnv())
      expect(err).to.include('legal erasure qfg-1234')
    })

    it('rejects with the identity key alone (no push option)', () => {
      const env = bypassEnv({GIT_PUSH_OPTION_0: undefined, GIT_PUSH_OPTION_COUNT: undefined})
      const {code} = run(mainRef(fixture.second, fixture.alt), env)
      expect(code).to.equal(1)
    })

    it('rejects with the push option alone (pusher is not the operator)', () => {
      const {code} = run(mainRef(fixture.second, fixture.alt), bypassEnv({GITEA_PUSHER_NAME: 'customer-admin'}))
      expect(code).to.equal(1)
    })

    it('rejects a push option with an empty reason', () => {
      const {code} = run(mainRef(fixture.second, fixture.alt), bypassEnv({GIT_PUSH_OPTION_0: 'quonfig-rewrite='}))
      expect(code).to.equal(1)
    })

    it('rejects when no operator account is configured, even if the pusher name matches', () => {
      const {code} = run(mainRef(fixture.second, fixture.alt), bypassEnv({QUONFIG_HOOK_OPERATOR: undefined}))
      expect(code).to.equal(1)
    })

    it('finds the option anywhere in the push-option list', () => {
      const env = bypassEnv({
        GIT_PUSH_OPTION_0: 'ci.skip',
        GIT_PUSH_OPTION_1: 'quonfig-rewrite=corruption repair qfg-9',
        GIT_PUSH_OPTION_COUNT: '2',
      })
      const {code, err} = run(mainRef(fixture.second, fixture.alt), env)
      expect(code, err).to.equal(0)
      expect(err).to.include('corruption repair qfg-9')
    })

    it('still runs content validation during a bypass', () => {
      // A bypassed push whose tree violates Policy A is still rejected.
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-ff-bad-'))
      tmpdirs.push(work)
      const git = (...args: string[]) => execFileSync('git', args, {cwd: work, encoding: 'utf8'}).trim()
      git('init', '--quiet', '--initial-branch', 'main')
      git('config', 'user.email', 'test@quonfig.test')
      git('config', 'user.name', 'test')
      writeConfig(work, 'configs/bad charset key.json', 'bad charset key')
      git('add', '-A')
      git('commit', '--quiet', '-m', 'bad')
      const bad = git('rev-parse', 'HEAD')

      const out: string[] = []
      const err: string[] = []
      const code = runHookChecks(mainRef(ZERO, bad), {
        cwd: work,
        env: bypassEnv(),
        log: (l: string) => out.push(l),
        logErr: (l: string) => err.push(l),
      })
      expect(code, [...out, ...err].join('\n')).to.equal(1)
      expect(out.join('\n')).to.match(/allowed set/i)
    })
  })

  describe('rollout allowlist', () => {
    it("does not enforce when the allowlist env var is unset (today's behaviour)", () => {
      const {code} = run(mainRef(fixture.second, fixture.alt), {
        GITEA_REPO_NAME: 'our-config',
        GITEA_REPO_USER_NAME: 'quonfig',
      })
      expect(code).to.equal(0)
    })

    it('does not enforce when the allowlist env var is empty', () => {
      const {code} = run(mainRef(fixture.second, fixture.alt), enforcingEnv({QUONFIG_HOOK_FF_ENFORCE: '  '}))
      expect(code).to.equal(0)
    })

    it('enforces on a listed repo and not on an unlisted one', () => {
      const listed = run(
        mainRef(fixture.second, fixture.alt),
        enforcingEnv({QUONFIG_HOOK_FF_ENFORCE: 'other/repo, quonfig/our-config'}),
      )
      expect(listed.code, 'listed repo').to.equal(1)

      const unlisted = run(
        mainRef(fixture.second, fixture.alt),
        enforcingEnv({GITEA_REPO_NAME: 'somebody-else', QUONFIG_HOOK_FF_ENFORCE: 'other/repo, quonfig/our-config'}),
      )
      expect(unlisted.code, 'unlisted repo').to.equal(0)
    })

    it('enforces on every repo with `*`', () => {
      const listed = run(mainRef(fixture.second, fixture.alt), enforcingEnv({QUONFIG_HOOK_FF_ENFORCE: '*'}))
      expect(listed.code, 'listed repo').to.equal(1)

      const unlisted = run(
        mainRef(fixture.second, fixture.alt),
        enforcingEnv({GITEA_REPO_NAME: 'somebody-else', QUONFIG_HOOK_FF_ENFORCE: '*'}),
      )
      expect(unlisted.code, 'unlisted repo').to.equal(1)
    })

    it('does not enforce when the repo cannot be identified from the Gitea env', () => {
      const {code} = run(
        mainRef(fixture.second, fixture.alt),
        enforcingEnv({GITEA_REPO_NAME: undefined, GITEA_REPO_USER_NAME: undefined}),
      )
      expect(code).to.equal(0)
    })
  })

  describe('version stamp', () => {
    it('prints `qfg-verify <sha>` as the first output line', () => {
      const {out} = run(mainRef(fixture.first, fixture.second), enforcingEnv({QFG_VERIFY_SHA: 'deadbeef1234'}))
      expect(out[0]).to.equal('qfg-verify deadbeef1234')
    })

    it('prints the stamp even when the push is rejected', () => {
      const {out} = run(mainRef(fixture.second, fixture.alt), enforcingEnv({QFG_VERIFY_SHA: 'deadbeef1234'}))
      expect(out[0]).to.equal('qfg-verify deadbeef1234')
    })

    it('falls back to `dev` when the build did not inject a sha', () => {
      expect(hookVersion({})).to.equal('dev')
      expect(hookVersion({QFG_VERIFY_SHA: '  '})).to.equal('dev')
      expect(hookVersion({QFG_VERIFY_SHA: 'abc1234'})).to.equal('abc1234')
    })
  })
})
