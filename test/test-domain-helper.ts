import {getApiUrl, getAppUrl} from '../src/util/domain-urls.js'

/**
 * Base URL the CLI will actually hit for oRPC API calls, honoring
 * `QUONFIG_DOMAIN`. CI sets `QUONFIG_DOMAIN=quonfig-staging.com`, so the CLI
 * requests `https://app.quonfig-staging.com/...`; locally the var is unset and
 * it falls back to `https://app.quonfig.com/...`.
 *
 * MSW handlers must build their match URLs from this helper instead of
 * hardcoding `https://app.quonfig.com`, otherwise they don't match under CI
 * and requests fall through unmatched (qfg-4tmh).
 */
export const getApiBase = (): string => getApiUrl()

/**
 * Base URL the CLI embeds in user-facing links (e.g. the `qfg info` flag URLs),
 * honoring `QUONFIG_DOMAIN`. Currently identical to {@link getApiBase} — both
 * resolve to `https://app.${domain}` — but kept distinct so tests asserting on
 * printed app links stay correct if the two ever diverge.
 */
export const getAppBase = (): string => getAppUrl()
