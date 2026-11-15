import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tracked = spawnSync('git', ['ls-files', '-z', '--', 'plugins', 'market'], {
  cwd: root,
  encoding: 'utf8',
})
if (tracked.error || tracked.status !== 0) {
  console.error('无法检查 Git 文件清单')
  process.exit(1)
}
const paths = tracked.stdout.split('\0').filter(Boolean)
if (paths.length) {
  console.error(
    `公开仓库不能跟踪 plugins/ 或 market/ 中的文件（共 ${paths.length} 个）。`,
  )
  console.error('使用 git rm --cached 取消跟踪，保留本地源码和发布产物。')
  process.exit(1)
}
console.log('公开仓库边界检查通过：插件源码和商店产物均留在本地。')
