export const INTERNAL_DISTRIBUTION = false
export const APP_NAME = 'UniAgent Public'
export const APP_BUNDLE_ID = 'com.uniagent.public'
export const PUBLIC_ARTIFACT_PREFIX = 'UniAgent-Public'
export const PUBLIC_REPOSITORY = 'https://github.com/musiczh/UniAgent'
export const PUBLIC_WEBSITE = 'https://musiczh.github.io/UniAgent/'
export const APP_REPOSITORY = PUBLIC_REPOSITORY
export function isDistributionAgent(agentId: string, adapter?: string): boolean { return !['traex', 'nika'].includes(agentId) && !['traex', 'nika'].includes(adapter || '') }
