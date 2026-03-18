const DEFAULT_DOMAIN = 'quonfig.com'

export const getDomain = (): string => process.env.QUONFIG_DOMAIN || DEFAULT_DOMAIN

export const getApiUrl = (domain?: string): string => {
  // Allow full override for local development
  if (process.env.QUONFIG_API_BASE_URL_OVERRIDE) {
    return process.env.QUONFIG_API_BASE_URL_OVERRIDE
  }

  const actualDomain = domain || getDomain()
  return `https://api.${actualDomain}`
}

export const getIdApiUrl = (domain?: string): string => {
  // Allow full override for local development - used for all OAuth operations
  if (process.env.IDENTITY_BASE_URL_OVERRIDE) {
    return process.env.IDENTITY_BASE_URL_OVERRIDE
  }

  const actualDomain = domain || getDomain()
  return `https://id.${actualDomain}`
}

export const getAppUrl = (domain?: string): string => {
  // Allow explicit override for app URL
  if (process.env.QUONFIG_APP_BASE_URL_OVERRIDE) {
    return process.env.QUONFIG_APP_BASE_URL_OVERRIDE
  }

  const actualDomain = domain || getDomain()
  return `https://app.${actualDomain}`
}
