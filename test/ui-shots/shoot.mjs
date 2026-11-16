/**
 * 用本机 Edge/Chrome 无头模式把 render-html.mjs 的产物截成整页 PNG（先量页高再截，不是只截首屏）。
 *
 * 用法：node test/ui-shots/shoot.mjs --html <file.html> --out <file.png> [--width 1100] [--theme light|dark]
 *   浏览器：UI_SHOTS_BROWSER 环境变量，否则依次试 Edge / Chrome 的默认安装路径。
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const html = opt('html'); const out = opt('out')
if (!html || !out) { console.error('用法：--html <file.html> --out <file.png> [--width 1100] [--theme light|dark]'); process.exit(2) }
const width = Number(opt('width', 1100)); const theme = opt('theme', 'light')

const browser = [process.env.UI_SHOTS_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p))
if (!browser) { console.error('找不到 Edge/Chrome，请设置 UI_SHOTS_BROWSER'); process.exit(2) }

const url = pathToFileURL(path.resolve(html)).href + '?theme=' + theme
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-'))
const base = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--user-data-dir=' + profile]
try {
  const dom = spawnSync(browser, [...base, '--dump-dom', `--window-size=${width},900`, url], { encoding: 'utf8', timeout: 60000 })
  const m = /data-h="(\d+)"/.exec(dom.stdout || '')
  const height = m ? Number(m[1]) + 8 : 3000
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  spawnSync(browser, [...base, `--window-size=${width},${height}`, '--screenshot=' + path.resolve(out), url], { encoding: 'utf8', timeout: 60000 })
  if (!fs.existsSync(out)) { console.error('截图失败'); process.exit(1) }
  console.log(`shoot ✓ ${out}  ${width}x${height}  theme=${theme}`)
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
