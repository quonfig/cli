export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_LEVEL_KEY_PREFIX = 'log-level.'

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}
