import {expect} from 'chai'
import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {
  __resetSleepForTests,
  __setSleepForTests,
  setLaunchDarklyBaseUrl,
} from '../../src/migrate/sources/launchdarkly/api.js'
import {
  type LDAuditLogEntry,
  auditEntryToLegacyChange,
  buildFlagAuditSpec,
  fetchAuditLogEntry,
  fetchAuditLogPage,
  getCommitMetaForAuditEntry,
  probeRetentionHorizon,
  walkAuditLog,
} from '../../src/migrate/sources/launchdarkly/audit.js'

const TEST_BASE_URL = 'https://ld.test/api/v2'
const DAY_MS = 86_400_000

/** A minimal LDFlag-shaped `currentVersion` payload for a flag audit entry. */
function flagVersion(key: string, value: boolean) {
  return {
    environments: {
      production: {on: value, fallthrough: {variation: value ? 0 : 1}},
    },
    key,
    kind: 'boolean',
    variations: [{value: true}, {value: false}],
  }
}

function listItem(id: string, date: number, name = 'flag-x') {
  return {_id: id, date, name, titleVerb: 'updated the flag'}
}

function fullEntry(id: string, date: number, key: string, value: boolean): LDAuditLogEntry {
  return {
    _id: id,
    currentVersion: flagVersion(key, value),
    date,
    member: {_id: 'm1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace'},
    name: key,
    shortDescription: `updated ${key}`,
    titleVerb: 'updated the flag',
  }
}

describe('migrate/sources/launchdarkly/audit', () => {
  let server: ReturnType<typeof setupServer>

  beforeEach(() => {
    setLaunchDarklyBaseUrl(TEST_BASE_URL)
    __setSleepForTests(async () => {})
  })

  afterEach(() => {
    if (server) server.close()
    __resetSleepForTests()
  })

  describe('buildFlagAuditSpec', () => {
    it('scopes the audit log to every flag in the project', () => {
      expect(buildFlagAuditSpec('acme-mobile')).to.equal('proj/acme-mobile:env/*:flag/*')
    })
  })

  describe('fetchAuditLogPage', () => {
    it('sends before, after, spec and limit=20 as query params', async () => {
      let seenUrl = ''
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          seenUrl = request.url
          return HttpResponse.json({items: [listItem('a1', 5000)]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const page = await fetchAuditLogPage('k', {after: 1000, before: 9000, spec: 'proj/default:env/*:flag/*'})
      const u = new URL(seenUrl)
      expect(u.searchParams.get('before')).to.equal('9000')
      expect(u.searchParams.get('after')).to.equal('1000')
      expect(u.searchParams.get('spec')).to.equal('proj/default:env/*:flag/*')
      expect(u.searchParams.get('limit')).to.equal('20')
      expect(page.items.map((i) => i._id)).to.deep.equal(['a1'])
    })
  })

  describe('fetchAuditLogEntry', () => {
    it('hydrates a single entry via GET /auditlog/{id}, including currentVersion', async () => {
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog/a1`, () => HttpResponse.json(fullEntry('a1', 5000, 'flag-x', true))),
      )
      server.listen({onUnhandledRequest: 'error'})

      const entry = await fetchAuditLogEntry('k', 'a1')
      expect(entry._id).to.equal('a1')
      expect(entry.currentVersion?.key).to.equal('flag-x')
    })
  })

  describe('walkAuditLog', () => {
    it('pages newest-to-oldest on the `before` cursor and hydrates every list entry', async () => {
      const seenBefores: Array<null | string> = []
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          const before = new URL(request.url).searchParams.get('before')
          seenBefores.push(before)
          // Page 1 (no before): two entries, newest first.
          if (!before) {
            return HttpResponse.json({items: [listItem('a3', 3000), listItem('a2', 2000)]})
          }

          // Page 2 (before=2000): one entry, then the stream is exhausted.
          if (before === '2000') {
            return HttpResponse.json({items: [listItem('a1', 1000)]})
          }

          return HttpResponse.json({items: []})
        }),
        http.get(`${TEST_BASE_URL}/auditlog/:id`, ({params}) => {
          const id = params.id as string
          const date = {a1: 1000, a2: 2000, a3: 3000}[id]!
          return HttpResponse.json(fullEntry(id, date, 'flag-x', true))
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const ids: string[] = []
      for await (const entry of walkAuditLog('k', {spec: 'proj/default:env/*:flag/*'})) {
        ids.push(entry._id)
      }

      // Newest-first across pages; the `before` cursor walked back the stream.
      expect(ids).to.deep.equal(['a3', 'a2', 'a1'])
      expect(seenBefores).to.include('2000')
    })

    it('resumes from `startBefore` instead of the newest entry', async () => {
      let firstBefore: null | string = 'unset'
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          if (firstBefore === 'unset') firstBefore = new URL(request.url).searchParams.get('before')
          return HttpResponse.json({items: []})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      // Empty stream; we only assert the `before` query param on the first request.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _entry of walkAuditLog('k', {startBefore: 4242})) {
        /* drain */
      }

      expect(firstBefore).to.equal('4242')
    })

    it('calls onCheckpoint after each page with the next `before` cursor', async () => {
      const checkpoints: number[] = []
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          const before = new URL(request.url).searchParams.get('before')
          if (!before) return HttpResponse.json({items: [listItem('a3', 3000), listItem('a2', 2000)]})
          return HttpResponse.json({items: []})
        }),
        http.get(`${TEST_BASE_URL}/auditlog/:id`, ({params}) =>
          HttpResponse.json(fullEntry(params.id as string, 0, 'flag-x', true)),
        ),
      )
      server.listen({onUnhandledRequest: 'error'})

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _entry of walkAuditLog('k', {
        onCheckpoint(before) {
          checkpoints.push(before)
        },
      })) {
        /* drain */
      }

      // After page 1 the resumable cursor is the oldest date seen so far (2000).
      expect(checkpoints[0]).to.equal(2000)
    })
  })

  describe('probeRetentionHorizon', () => {
    it('flags a likely Developer plan when nothing older than 30 days is retained', async () => {
      const now = 1_000_000_000_000
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          const before = Number(new URL(request.url).searchParams.get('before'))
          // Only entries within the last 30 days exist; the 30-day boundary probe
          // (before = now - 30d) comes back empty.
          if (before <= now - 30 * DAY_MS) return HttpResponse.json({items: []})
          return HttpResponse.json({items: [listItem('recent', now - DAY_MS)]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const horizon = await probeRetentionHorizon('k', {now})
      expect(horizon.developerPlanLikely).to.equal(true)
      expect(horizon.oldestReachableMs).to.equal(null)
    })

    it('reports the oldest reachable entry when history extends past 30 days', async () => {
      const now = 1_000_000_000_000
      const oldest = now - 400 * DAY_MS
      server = setupServer(
        http.get(`${TEST_BASE_URL}/auditlog`, ({request}) => {
          const before = Number(new URL(request.url).searchParams.get('before'))
          // History reaches ~400 days back but no further.
          if (before <= oldest) return HttpResponse.json({items: []})
          return HttpResponse.json({items: [listItem('old', oldest)]})
        }),
      )
      server.listen({onUnhandledRequest: 'error'})

      const horizon = await probeRetentionHorizon('k', {now})
      expect(horizon.developerPlanLikely).to.equal(false)
      expect(horizon.oldestReachableMs).to.equal(oldest)
    })
  })

  describe('auditEntryToLegacyChange', () => {
    it('maps a flag audit entry to a LegacyChange carrying currentVersion as the flag payload', () => {
      const entry = fullEntry('a1', 7777, 'flag-x', false)
      const change = auditEntryToLegacyChange(entry)
      expect(change).to.not.equal(null)
      expect(change!.source).to.equal('launchdarkly')
      expect(change!.key).to.equal('flag-x')
      expect(change!.changedAt).to.equal(7777)
      const raw = change!.raw as {data: {key: string}; kind: string}
      expect(raw.kind).to.equal('flag')
      expect(raw.data.key).to.equal('flag-x')
    })

    it('returns null for an entry with no currentVersion (deleted resource / non-flag)', () => {
      const entry: LDAuditLogEntry = {_id: 'x', date: 1, name: 'something'}
      expect(auditEntryToLegacyChange(entry)).to.equal(null)
    })
  })

  describe('getCommitMetaForAuditEntry', () => {
    it('reifies the original member, date and description into commit metadata', () => {
      const entry = fullEntry('a1', 9999, 'flag-x', true)
      const meta = getCommitMetaForAuditEntry(entry)
      expect(meta).to.not.equal(null)
      expect(meta!.author).to.deep.equal({email: 'ada@example.com', name: 'Ada Lovelace'})
      expect(meta!.date).to.equal(9999)
      expect(meta!.message).to.equal('updated flag-x')
    })

    it('falls back to a non-empty migrator message when the entry carries no description', () => {
      const entry: LDAuditLogEntry = {
        _id: 'a2',
        currentVersion: flagVersion('flag-y', true),
        date: 1234,
        member: {email: 'grace@example.com'},
        name: 'flag-y',
      }
      const meta = getCommitMetaForAuditEntry(entry)
      expect(meta!.message.length).to.be.greaterThan(0)
      expect(meta!.message).to.match(/flag-y/)
      // email-only member still produces a usable author name
      expect(meta!.author.name).to.equal('grace@example.com')
    })
  })
})
