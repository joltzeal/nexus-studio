import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

interface DirectoryOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  query?: (command: string, args: string[]) => Promise<string>
}

const WINDOWS_DOWNLOADS = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$key = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'",
  "$folder = $key.'{374DE290-123F-4565-9164-39C4925E467B}'",
  'if ($folder) { [Environment]::ExpandEnvironmentVariables($folder) }',
].join('; ')

function queryDirectory(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

/** Resolve the user's visible download location, including Windows redirection. */
export async function imageExportDirectory(
  options: DirectoryOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const home = options.homeDirectory ?? homedir()
  const path = platform === 'win32' ? win32 : posix
  const query = options.query ?? queryDirectory
  let downloads = path.join(home, 'Downloads')
  try {
    const response =
      platform === 'win32'
        ? await query('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            WINDOWS_DOWNLOADS,
          ])
        : platform === 'darwin'
          ? await query('/usr/bin/osascript', [
              '-e',
              'POSIX path of (path to downloads folder)',
            ])
          : await query('xdg-user-dir', ['DOWNLOAD'])
    const candidate = response.trim()
    if (
      path.isAbsolute(candidate) &&
      !/[\r\n\0]/.test(candidate) &&
      (platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(candidate))
    ) {
      downloads = candidate
    }
  } catch {
    // Missing OS helpers still use Downloads; file-write errors never fall back.
  }
  return path.join(downloads, 'Nexus AI')
}
