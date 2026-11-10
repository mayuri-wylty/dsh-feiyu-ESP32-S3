/**
 * 把 Windows SAPI 生成的 WAV（fmt 块可能为 18 字节）规范化为
 * DSH validateWave 要求的 44 字节 canonical 16 kHz mono PCM16 WAV。
 *
 * 用法：
 *   node normalize-wav.mjs <input.wav> <output.wav>
 */
import fs from 'node:fs'

const [, , input, output] = process.argv
if (!input || !output) {
  console.error('用法: node normalize-wav.mjs <input.wav> <output.wav>')
  process.exit(2)
}

const d = fs.readFileSync(input)
if (d.toString('ascii', 0, 4) !== 'RIFF' || d.toString('ascii', 8, 12) !== 'WAVE') {
  throw new Error('不是 RIFF/WAVE 文件')
}

let off = 12
let fmt = null
let data = null
while (off + 8 <= d.length) {
  const id = d.toString('ascii', off, off + 4)
  const size = d.readUInt32LE(off + 4)
  const body = off + 8
  if (id === 'fmt ') fmt = d.subarray(body, body + size)
  if (id === 'data') data = d.subarray(body, body + size)
  off += 8 + size + (size % 2)
}
if (!fmt || !data) throw new Error('缺少 fmt 或 data 块')
if (fmt.length < 16
  || fmt.readUInt16LE(0) !== 1
  || fmt.readUInt16LE(2) !== 1
  || fmt.readUInt32LE(4) !== 16000
  || fmt.readUInt32LE(8) !== 32000
  || fmt.readUInt16LE(12) !== 2
  || fmt.readUInt16LE(14) !== 16) {
  throw new Error('输入不是 16 kHz mono PCM16')
}

const out = Buffer.alloc(44 + data.length)
out.write('RIFF', 0, 'ascii')
out.writeUInt32LE(36 + data.length, 4)
out.write('WAVE', 8, 'ascii')
out.write('fmt ', 12, 'ascii')
out.writeUInt32LE(16, 16)
out.writeUInt16LE(1, 20)
out.writeUInt16LE(1, 22)
out.writeUInt32LE(16000, 24)
out.writeUInt32LE(32000, 28)
out.writeUInt16LE(2, 32)
out.writeUInt16LE(16, 34)
out.write('data', 36, 'ascii')
out.writeUInt32LE(data.length, 40)
data.copy(out, 44)
fs.writeFileSync(output, out)

console.log(JSON.stringify({
  input,
  output,
  bytes: out.length,
  seconds: data.length / 32000,
  canonical: true,
}, null, 2))
