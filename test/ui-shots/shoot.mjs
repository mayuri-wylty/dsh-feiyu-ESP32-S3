/**
 * 用本机 Edge/Chrome 无头模式把 render-html.mjs 的产物截成整页 PNG（先量页高再截，不是只截首屏）。
 *
 * 用法：node test/ui-shots/shoot.mjs --html <file.html> --out <file.png> [--width 1100] [--theme light|dark]
 *       node test/ui-shots/shoot.mjs --html <file.html> --measure [--width 360,420,768,1100] [--theme light|dark]
 *   浏览器：UI_SHOTS_BROWSER 环境变量，否则依次试 Edge / Chrome 的默认安装路径。
 *
 * 为什么套 iframe：无头浏览器的窗口有最小宽度（约 500px），直接 --window-size=420 实际按 500 排版再裁切，
 * 会把"没溢出"看成"被截断"，也量不出真实 scrollWidth。这里把页面放进精确宽度的 iframe 里渲染。
 *   截图：左侧是 iframe（宽 = --width），右侧灰底；卡片右边框完整可见 = 没有横向溢出。
 *   --measure：读 iframe 内 documentElement.scrollWidth，逐个宽度打印；任一宽度 scrollWidth > 视口宽度则退出码 1。
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const measure = args.includes('--measure')
const html = opt('html'); const out = opt('out')
if (!html || (!out && !measure)) { console.error('用法：--html <file.html> (--out <file.png> | --measure) [--width 1100|360,420,768,1100] [--theme light|dark]'); process.exit(2) }
const widths = String(opt('width', measure ? '360,420,768,1100' : '1100')).split(',').map(Number).filter((n) => n > 0)
const theme = opt('theme', 'light')

const browser = [process.env.UI_SHOTS_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find((p) => fs.existsSync(p))
if (!browser) { console.error('找不到 Edge/Chrome，请设置 UI_SHOTS_BROWSER'); process.exit(2) }

const url = pathToFileURL(path.resolve(html)).href + '?theme=' + theme
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-'))
const base = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--allow-file-access-from-files', '--user-data-dir=' + profile]

// 包装页：精确宽度的 iframe（scrolling=no，高度先给足），加载后把 iframe 内的 scrollWidth / scrollHeight 写到自己的 data-* 上
function wrapper(w, h) {
  const file = path.join(profile, `wrap-${w}-${h}.html`)
  fs.writeFileSync(file, `<!doctype html><html><body style="margin:0;background:#8a8a8a"><iframe id="f" src="${url}" scrolling="no" style="display:block;border:0;background:#fff;width:${w}px;height:${h}px"></iframe>`
    + `<script>document.getElementById('f').addEventListener('load',function(){setTimeout(function(){var d=document.getElementById('f').contentDocument.documentElement;`
    + `document.documentElement.setAttribute('data-sw',String(d.scrollWidth));document.documentElement.setAttribute('data-sh',String(d.scrollHeight))},50)})</script></body></html>`)
  return pathToFileURL(file).href
}
function probe(w) {
  const dom = spawnSync(browser, [...base, '--dump-dom', '--virtual-time-budget=4000', `--window-size=${Math.max(w, 500) + 40},900`, wrapper(w, 100)], { encoding: 'utf8', timeout: 60000 })
  const sw = /data-sw="(\d+)"/.exec(dom.stdout || ''); const sh = /data-sh="(\d+)"/.exec(dom.stdout || '')
  return { sw: sw ? Number(sw[1]) : NaN, sh: sh ? Number(sh[1]) : NaN }
}

try {
  if (measure) {
    let bad = 0
    for (const w of widths) {
      const { sw } = probe(w)
      const ok = Number.isFinite(sw) && sw <= w
      if (!ok) bad++
      console.log(`measure ${ok ? '✓' : '✗'} viewport=${w} scrollWidth=${sw}`)
    }
    process.exit(bad ? 1 : 0)
  }
  const w = widths[0]
  const { sw, sh } = probe(w)
  const height = Number.isFinite(sh) ? sh + 8 : 3000
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  spawnSync(browser, [...base, `--window-size=${w},${height}`, '--screenshot=' + path.resolve(out), wrapper(w, height)], { encoding: 'utf8', timeout: 60000 })
  if (!fs.existsSync(out)) { console.error('截图失败'); process.exit(1) }
  console.log(`shoot ✓ ${out}  ${w}x${height}  theme=${theme}  scrollWidth=${sw}`)
} finally {
  fs.rmSync(profile, { recursive: true, force: true })
}
