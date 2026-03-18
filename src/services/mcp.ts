import {homedir} from 'node:os'
import {join} from 'node:path'

export const SupportedEditors = ['claude-code', 'codeium'] as const
export type SupportedEditor = (typeof SupportedEditors)[number]

type ConfigPaths = {
  name: string
  global:
    | {
        mac: string
        windows: string
        linux?: string
      }
    | string
  local?: string
}

export const ConfigPaths: Record<SupportedEditor, ConfigPaths> = {
  // cursor: {
  //   name: 'Cursor',
  //   global: '~/.cursor/mcp.json',
  //   local: '.cursor/mcp.json',
  // },
  'claude-code': {
    name: 'Claude Code',
    global: '~/.claude.json',
  },
  codeium: {
    name: 'Codeium (Codex)',
    global: {
      mac: '~/Library/Application Support/Codeium/mcp_config.json',
      windows: '@/Codeium/mcp_config.json',
      linux: '~/.config/codeium/mcp_config.json',
    },
  },
}

function resolvePath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (path.startsWith('@/')) {
    // Windows AppData
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, path.slice(2))
  }
  return path
}

export function resolveConfigPath(editor: SupportedEditor, local = false): string | undefined {
  const editorConfig = ConfigPaths[editor]
  const paths = local ? editorConfig.local : editorConfig.global

  if (!paths) return undefined

  if (typeof paths === 'string') {
    return resolvePath(paths)
  }

  // Platform-specific paths
  switch (process.platform) {
    case 'darwin':
      return resolvePath(paths.mac)
    case 'win32':
      return resolvePath(paths.windows)
    case 'linux':
      return paths.linux ? resolvePath(paths.linux) : undefined
    default:
      return undefined
  }
}

export function getServersConfig(editorConfig: Record<string, unknown>): Record<string, unknown> {
  if (!editorConfig.mcpServers) {
    editorConfig.mcpServers = {}
  }
  return editorConfig.mcpServers as Record<string, unknown>
}
