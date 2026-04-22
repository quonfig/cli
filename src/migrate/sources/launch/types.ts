export interface LaunchValue {
  type: string
  value: unknown
}

export interface LaunchCriterion {
  operator: string
  propertyName?: string
  valueToMatch?: LaunchValue
}

export interface LaunchRule {
  criteria: LaunchCriterion[]
  value: LaunchValue
}

export interface LaunchEnvironmentRow {
  id: string
  rules: LaunchRule[]
}

export interface LaunchChangedBy {
  email: string
  fullName?: string
  id: string
  type: string
}

export interface LaunchConfig {
  allowableValues?: LaunchValue[]
  changedBy?: LaunchChangedBy
  default?: {rules: LaunchRule[]}
  environments: LaunchEnvironmentRow[]
  id: string
  key: string
  projectId: string
  schemaKey?: string
  sendToClientSdk?: boolean
  type: string
  valueType: string
  variants?: Array<{value?: LaunchValue}>
}

export interface LaunchChangeEntry {
  changedAt: number
  changedBy: LaunchChangedBy
  deleted: boolean
  key: string
  newConfig?: LaunchConfig
  newConfigId: number | string
  previousConfigId?: number | string
  summary?: string
  type: string
  version?: number | string
}

export interface LaunchChangeHistoryResponse {
  changes: LaunchChangeEntry[]
  cursor?: string
}

export interface LaunchProjectEnvironmentsResponse {
  envs: Array<{id: number; name: string}>
  projectId: number
}

export interface LaunchChangeGroup {
  changedAt: number
  changedBy: LaunchChangedBy
  changes: LaunchChangeEntry[]
  groupKey: string
  summary: string
}
