import packageInfo from '../../../package.json'

export const APP_VERSION = packageInfo.version

export interface AppInfo {
  version: string
  platform: string
  architecture: string
  browserStatus: 'not-connected'
}

export async function getAppInfo(): Promise<AppInfo> {
  return {
    version: APP_VERSION,
    platform: 'frontend-demo',
    architecture: 'not-detected',
    browserStatus: 'not-connected',
  }
}
