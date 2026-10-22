import packageInfo from '../../../package.json'

export interface AppInfo {
  version: string
  platform: string
  architecture: string
  browserStatus: 'not-connected'
}

export async function getAppInfo(): Promise<AppInfo> {
  return {
    version: packageInfo.version,
    platform: 'frontend-demo',
    architecture: 'not-detected',
    browserStatus: 'not-connected',
  }
}
