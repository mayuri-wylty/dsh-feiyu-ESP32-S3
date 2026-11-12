#!/usr/bin/env node
// 把 deps/ 下的运行环境路径写进 ~/.dsh/feiyu.config.json（深合并，保留既有 esp32/llm/owner 等段落）。
//
// 用法： node scripts/merge-feiyu-config.mjs [仓库根目录] [napcat 启动脚本路径]
//
// 说明：
// - 只写入路径类字段，不写入任何密钥；密钥仍由用户自行放在该文件里。
// - 深合并：既有同名键（如 esp32.asr / llm.apiKey）原样保留。
// - 路径统一写成正斜杠，重复运行结果不变（幂等）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fwd = (p) => String(p).replace(/\\/g, '/')
const repo = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
// D:/NapCat 是 junction，真实文件在 deps/napcat/napcat（仓库内）；联接不可用时由 setup-deps.ps1 传入直连路径
const launcher = fwd(process.argv[3] ?? 'D:/NapCat/start-qq-gateway.bat')
const cfgPath = path.join(os.homedir(), '.dsh', 'feiyu.config.json')

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base?.[k] ?? {}, v) : v
  }
  return out
}

let cur = {}
if (fs.existsSync(cfgPath)) {
  try {
    cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(`配置文件解析失败，未改动：${cfgPath} (${e.message})`)
    process.exit(1)
  }
}

const next = merge(cur, {
  douyin: {
    python: fwd(path.join(repo, 'deps', 'douyin', '.venv', 'Scripts', 'python.exe')),
    script: fwd(path.join(repo, 'douyin_interact.py')),
  },
  wechat: {
    python: fwd(path.join(repo, 'deps', 'wechat', '.venv', 'Scripts', 'python.exe')),
    script: fwd(path.join(repo, 'wechat', 'wechat_bot.py')),
  },
  qq: {
    napcat_launcher: launcher,
  },
})

const before = JSON.stringify(cur)
const after = JSON.stringify(next)
if (before === after) {
  console.log(`unchanged: ${cfgPath}`)
} else {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  const tmp = `${cfgPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, cfgPath)
  console.log(`written: ${cfgPath}`)
}
console.log(`sections: ${Object.keys(next).join(', ')}`)
console.log(`douyin.python = ${next.douyin.python}`)
console.log(`wechat.python = ${next.wechat.python}`)
console.log(`qq.napcat_launcher = ${next.qq.napcat_launcher}`)
console.log(`kept: esp32=${!!next.esp32} llm=${!!next.llm} owner=${!!next.owner}`)
