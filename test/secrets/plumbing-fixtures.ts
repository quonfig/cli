/**
 * Shared fixtures for the secrets plumbing tests (bead qfg-mol-hle PR 2).
 * Keys are minted at run time; no private key literal is ever committed.
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {type Keypair, formatPrivateKeyEntry, formatPublicKeyEntry, mintKeypair} from '../../src/secrets/qf1.js'

export type TestKey = {privateEntry: string; publicEntry: string} & Keypair

export function testKey(): TestKey {
  const k = mintKeypair(new Set())
  return {...k, privateEntry: formatPrivateKeyEntry(k.privateKey), publicEntry: formatPublicKeyEntry(k.publicKey)}
}

/** A quonfig.json text with `keysets` (name -> public entries) in the given order. */
export function quonfigJson(keysets?: Record<string, unknown>, environments = ['production', 'staging']): string {
  const doc: Record<string, unknown> = {environments, workspace: 'acme-test'}
  if (keysets !== undefined) doc.secrets = {keysets}
  return JSON.stringify(doc, null, 2)
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim()
}

/**
 * A bare repo whose `main` holds `files` (path -> text) in one commit, as a
 * workspace repo on Gitea would. Returns the bare repo path and main's sha.
 */
export function bareWorkspaceRepo(
  root: string,
  files: Record<string, string>,
  options: {branch?: string; symlinks?: Record<string, string>} = {},
): {bare: string; headSha: string} {
  const work = path.join(root, 'work')
  const bare = path.join(root, 'workspace.git')
  fs.mkdirSync(work, {recursive: true})
  git(work, 'init', '-q')
  git(work, 'checkout', '-q', '-b', options.branch ?? 'main')
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), {recursive: true})
    fs.writeFileSync(path.join(work, rel), text)
  }

  git(work, 'add', '-A')
  // Symlink entries go straight into the index (mode 120000), so the fixture
  // needs no symlink support from the filesystem (Windows CI).
  for (const [rel, target] of Object.entries(options.symlinks ?? {})) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: work,
      encoding: 'utf8',
      input: target,
    }).trim()
    git(work, 'update-index', '--add', '--cacheinfo', `120000,${blob},${rel}`)
  }

  git(work, 'commit', '-q', '-m', 'seed')
  git(root, 'clone', '-q', '--bare', work, bare)
  return {bare, headSha: git(work, 'rev-parse', 'HEAD')}
}

/** A plain string config in configs/, as the server writes one. */
export function configDoc(key: string): string {
  return JSON.stringify(
    {
      $schema: 'https://api.quonfig.com/schemas/v1/stored-config.json',
      key,
      type: 'config',
      valueType: 'string',
      sendToClientSdk: false,
      access: 'standard',
      tags: [],
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'plain'}}]},
      environments: [],
      variants: [],
    },
    null,
    2,
  )
}
