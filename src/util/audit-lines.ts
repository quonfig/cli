export type AuditMessage = {
  message: string
  scope: string
}

const INDENT = '    '

/**
 * The lines `qfg activity feed` and `qfg activity history` print under an
 * entry, one per server message.
 *
 * The server's messages are redline lines ("+ everyone gets false") that do
 * not name their environment; the environment is the message's `scope`. So
 * each line is printed as "<scope>: <message>". The first line of a created,
 * deleted or restored entry is its header ('Created feature flag "x" (bool)')
 * and stands alone. This is the same rule the server uses for a change
 * request's summary lines.
 */
export function auditLines(action: string, messages: AuditMessage[]): string[] {
  return messages.map((m, i) => {
    const isHeader = i === 0 && action !== 'updated'
    return isHeader || !m.scope ? `${INDENT}${m.message}` : `${INDENT}${m.scope}: ${m.message}`
  })
}
