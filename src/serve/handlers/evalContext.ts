/**
 * Handler for `GET /api/v2/configs/eval-with-context/{base64url(ctx)}`.
 *
 * Mirrors api-delivery/internal/serve/eval_context.go so SDK clients see the
 * same EvalEnvelope shape they get in production. The fields are:
 *
 *   { evaluations: { [key]: {
 *       value: { type, value, confidential?, decryptWith? },
 *       configId, configType, valueType, reason,
 *       ruleIndex?, weightedValueIndex?
 *     } },
 *     meta: { version, environment }
 *   }
 *
 * `reason` follows the cross-SDK spec
 * `project/plans/openfeature-resolution-details.md`:
 *   - "SPLIT"            for weighted-value flags
 *   - "TARGETING_MATCH"  for configs whose matched rule has a non-ALWAYS_TRUE criterion
 *   - "STATIC"           otherwise
 *
 * `ruleIndex` and `weightedValueIndex` are emitted only when the reason class
 * carries useful information (TARGETING_MATCH or SPLIT). This matches the Go
 * handler's "omit, don't null" rule.
 */

import type {IncomingMessage, ServerResponse} from 'node:http'

import type {ConfigResponse, Criterion, EvalMatch, Evaluator, Rule, ConfigStore} from '@quonfig/node'

export interface EvalEnvelope {
  evaluations: Record<string, EvalResult>
  meta: {version: string; environment: string}
}

export interface EvalResult {
  configId: string
  configType: string
  reason: string
  ruleIndex?: number
  value: {type: string; value: unknown; confidential?: boolean; decryptWith?: string}
  valueType: string
  weightedValueIndex?: number
}

export interface EvalHandlerDeps {
  /**
   * Snapshot accessor — returns the *current* store + evaluator + meta. We
   * read this on every request so that auto-reload swaps under us
   * transparently.
   *
   * Note (qfg-38sf.1 audit, F3): the sendToClientSdk filter is unconditional
   * and lives inside this handler. There is no `frontendFilter` toggle —
   * every qfg serve consumer is a frontend client by definition, so the
   * filter always applies.
   */
  getSnapshot(): {
    store: ConfigStore
    evaluator: Evaluator
    environment: string
    version: string
  }
}

/**
 * G6 (qfg-38sf.1 audit): cap on the raw base64 context token length before
 * we allocate a Buffer for it. 64 KB is well above the realistic size of any
 * SDK-sent context envelope (Quonfig contexts are typically a few hundred
 * bytes; the SDK base64-encodes a small JSON object) while still bounded
 * enough to prevent a malicious client from forcing the server to allocate
 * a multi-megabyte buffer per request.
 */
const MAX_CTX_TOKEN_BYTES = 64 * 1024

export async function handleEvalContext(
  req: IncomingMessage,
  res: ServerResponse,
  ctxToken: string,
  deps: EvalHandlerDeps,
): Promise<void> {
  // G6: bound the token size BEFORE we decode it. The 64KB cap is way above
  // realistic context payloads and small enough that a malicious caller
  // can't trick us into allocating gigabytes. 414 URI Too Long is the right
  // status — RFC 7231 §6.5.12 covers exactly this case (the URL is the
  // request-target, the ctx is a path segment, so it's a URI-length problem,
  // not a body-length problem).
  if (ctxToken.length > MAX_CTX_TOKEN_BYTES) {
    res.writeHead(414, {'Content-Type': 'text/plain'})
    res.end('context token too large')
    return
  }

  // base64url decode → JSON. We accept the URL-safe alphabet and the
  // standard one because the Go handler does (`base64.URLEncoding`,
  // `StdEncoding`, `RawURLEncoding` — Node's "base64url" parser already
  // covers the no-padding URL-safe case; we try standard as a fallback).
  let contextData: Record<string, Record<string, unknown>>
  try {
    let json: string
    try {
      json = Buffer.from(ctxToken, 'base64url').toString('utf8')
    } catch {
      json = Buffer.from(ctxToken, 'base64').toString('utf8')
    }
    contextData = JSON.parse(json)
  } catch {
    res.writeHead(400, {'Content-Type': 'text/plain'})
    res.end('invalid context token encoding')
    return
  }

  const snap = deps.getSnapshot()
  const evaluations: Record<string, EvalResult> = {}

  // The SDK's Evaluator takes a `Contexts` map shaped exactly like the JSON
  // we just decoded: { [contextName]: { [key]: value } }. No translation
  // needed.
  for (const key of snap.store.keys()) {
    const cfg = snap.store.get(key) as ConfigResponse | undefined
    if (!cfg) continue

    // F3 (qfg-38sf.1 audit): UNCONDITIONAL sendToClientSdk filter. Every qfg
    // serve consumer is a frontend client by definition, so we apply the
    // same gate api-delivery uses for frontend SDK keys
    // (eval_context.go:103) regardless of whether --frontend-sdk-key was
    // passed. Feature flags bypass the filter, matching the Go behavior.
    if (cfg.type !== 'feature_flag' && !cfg.sendToClientSdk) {
      continue
    }

    const match: EvalMatch = snap.evaluator.evaluateConfig(cfg, snap.environment, contextData)
    if (!match.isMatch || match.value === undefined) continue

    const reason = resolutionReason(cfg, match)
    const result: EvalResult = {
      value: {
        type: match.value.type,
        value: match.value.value,
      },
      configId: cfg.id,
      configType: cfg.type,
      valueType: cfg.valueType,
      reason,
    }
    if (match.value.confidential !== undefined) result.value.confidential = match.value.confidential
    if (match.value.decryptWith !== undefined) result.value.decryptWith = match.value.decryptWith
    if (reason === 'TARGETING_MATCH' || reason === 'SPLIT') {
      result.ruleIndex = match.ruleIndex
    }
    if (reason === 'SPLIT') {
      result.weightedValueIndex = match.weightedValueIndex
    }
    evaluations[cfg.key] = result
  }

  const envelope: EvalEnvelope = {
    evaluations,
    meta: {version: snap.version, environment: snap.environment},
  }

  res.writeHead(200, {'Content-Type': 'application/json'})
  res.end(JSON.stringify(envelope))
}

function resolutionReason(cfg: ConfigResponse, _match: EvalMatch): string {
  if (cfg.valueType === 'weighted_values') return 'SPLIT'
  if (hasResolutionTargeting(cfg)) return 'TARGETING_MATCH'
  return 'STATIC'
}

function hasResolutionTargeting(cfg: ConfigResponse): boolean {
  if (rulesAreTargeted(cfg.default?.rules)) return true
  const envRules = cfg.environment?.rules
  if (rulesAreTargeted(envRules)) return true
  return false
}

function rulesAreTargeted(rules: Rule[] | undefined): boolean {
  if (!rules) return false
  for (const rule of rules) {
    for (const criterion of rule.criteria as Criterion[]) {
      if (criterion.operator !== 'ALWAYS_TRUE') return true
    }
  }
  return false
}
