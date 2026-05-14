import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolve the directory the CLI uses for tokens, profile config, and gitea
 * tokens. Honors `QUONFIG_CONFIG_HOME` so tests (and anyone who wants an
 * isolated config dir) can redirect away from `~/.quonfig/`.
 */
export const getQuonfigConfigHome = (): string => process.env.QUONFIG_CONFIG_HOME || path.join(os.homedir(), '.quonfig')
