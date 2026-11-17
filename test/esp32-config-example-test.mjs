// feiyu.config.example.json：能解析、esp32 段与契约默认值一致（防漂移）、不含任何密钥/令牌
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULT_ESP32_CONFIG } from '../lib/esp32/contracts.js'

const example = JSON.parse(fs.readFileSync(new URL('../feiyu.config.example.json', import.meta.url), 'utf8'))

test('示例配置的 esp32 段与 DEFAULT_ESP32_CONFIG 一致', () => {
  assert.deepEqual(example.esp32, JSON.parse(JSON.stringify(DEFAULT_ESP32_CONFIG)))
})

test('示例配置不含密钥、令牌或私人标识', () => {
  const secretKeys = /(api_?key|token|secret|password|sessdata|bili_jct)$/i
  const walk = (obj, trail = '') => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${trail}${k}.`)
      else if (secretKeys.test(k)) assert.equal(v, '', `${trail}${k} 必须为空`)
    }
  }
  walk(example)
  assert.equal(example.guard.dryRun, true, '示例默认干跑')
})
