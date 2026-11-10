// 有理数比多相 FIR 重采样（纯 JS，禁止线性插值）。
//
// 典型用途：设备参考音/播放链路是 32kHz，而协议下行是 24kHz，需要 32k→24k；
// 也提供通用的 resamplePcm(pcm, from, to)（如 32k→16k、24k→16k）。
//
// 算法：
//   1. 用 gcd 把 from→to 化为 L:M（上采样 L 倍、下采样 M 倍，上采样后速率 Fu=from*L）。
//   2. 设计 Kaiser 窗（β 对应 ~80dB 阻带）sinc 低通，截止取
//      0.5*min(from,to)*0.94，系数总和归一化为 L（上采样插零后低通增益为 L，
//      即每个相位系数和≈1，保证重采样后幅度不变）。
//   3. 按 L 个相位分解滤波器，逐输出点只做约 N/L 次乘加（多相结构）。
//   4. 输出长度 round(len*to/from)；边界样本按可用输入截断，不做线性插值。
//
// 实测（见 test/esp32-audio-test.mjs）：32k→24k 时 14kHz 输入在 10kHz 的镜像
// 比 1kHz 通带参考低约 97dB（要求 ≤ −40dB）；1 秒音频约 5ms。

const KAISER_ATTEN_DB = 80
const MIN_TAPS = 161
const TAPS_PER_PHASE = 32
const CUTOFF_MARGIN = 0.94
const FILTER_CACHE_LIMIT = 32

const filterCache = new Map()

function gcd(a, b) {
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

/** 零阶第一类修正 Bessel 函数 I0(x)，级数展开到收敛。 */
function besselI0(x) {
  const y = (x * x) / 4
  let sum = 1
  let term = 1
  for (let k = 1; k < 200; k++) {
    term *= y / (k * k)
    sum += term
    if (term < sum * 1e-15) break
  }
  return sum
}

function sinc(x) {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

/**
 * 设计 L/M 多相低通滤波器。
 * @returns {{L:number, M:number, D:number, taps:number, phases:Float64Array[]}}
 */
function designFilter(from, to) {
  const g = gcd(from, to)
  const L = to / g
  const M = from / g

  let taps = Math.max(MIN_TAPS, TAPS_PER_PHASE * L + 1)
  if (taps % 2 === 0) taps += 1
  const delay = (taps - 1) / 2

  const upsampleRate = from * L
  const cutoffNorm = (0.5 * Math.min(from, to) * CUTOFF_MARGIN) / upsampleRate // 相对 Fu
  const beta = 0.1102 * (KAISER_ATTEN_DB - 8.7)
  const i0Beta = besselI0(beta)

  const h = new Float64Array(taps)
  let total = 0
  for (let k = 0; k < taps; k++) {
    const t = k - delay
    const ratio = (2 * k) / (taps - 1) - 1 // −1..1
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0Beta
    // 2*fc*sinc(2*fc*t) 即截止频率为 fc（相对 Fu）的理想低通冲激响应。
    h[k] = 2 * cutoffNorm * sinc(2 * cutoffNorm * t) * window
    total += h[k]
  }
  // 上采样 L 倍等效于插零后低通；滤波器直流增益必须是 L（每个相位和≈1），
  // 否则输出幅度会缩小为 1/L（32k→24k 时实测正好 1/3）。
  const scale = L / total
  for (let k = 0; k < taps; k++) h[k] *= scale

  const phases = new Array(L)
  for (let p = 0; p < L; p++) {
    const count = Math.ceil((taps - p) / L)
    const coefs = new Float64Array(count)
    for (let j = 0; j < count; j++) coefs[j] = h[p + j * L]
    phases[p] = coefs
  }

  return { L, M, D: delay, taps, phases }
}

function getFilter(from, to) {
  const key = `${from}->${to}`
  let filter = filterCache.get(key)
  if (filter) return filter
  filter = designFilter(from, to)
  if (filterCache.size >= FILTER_CACHE_LIMIT) filterCache.clear()
  filterCache.set(key, filter)
  return filter
}

/**
 * 重采样单声道 Int16Array。from === to 时原样返回（同一引用，不复制）。
 *
 * @param {Int16Array} pcm 输入 PCM16
 * @param {number} from 输入采样率
 * @param {number} to 输出采样率
 * @returns {Int16Array} 输出 PCM16，长度 round(pcm.length*to/from)
 */
export function resamplePcm(pcm, from, to) {
  if (!(pcm instanceof Int16Array)) {
    throw new TypeError('resamplePcm: 需要 Int16Array')
  }
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0) {
    throw new RangeError(`resamplePcm: 非法采样率 ${from} → ${to}`)
  }
  if (from === to) return pcm
  if (pcm.length === 0) return new Int16Array(0)

  const { L, M, D, phases } = getFilter(from, to)
  const len = pcm.length
  const outLen = Math.round((len * to) / from)
  const out = new Int16Array(outLen)

  for (let n = 0; n < outLen; n++) {
    // s 是“上采样域”中的输出时刻；补偿滤波器群延迟 D，使输出与输入时间对齐。
    const s = n * M + D
    const base = Math.floor(s / L)
    const phase = s - base * L
    const coefs = phases[phase]

    const jLo = Math.max(0, base - (len - 1))
    const jHi = Math.min(coefs.length - 1, base)

    let acc = 0
    for (let j = jLo; j <= jHi; j++) acc += coefs[j] * pcm[base - j]

    let v = Math.round(acc)
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    out[n] = v
  }

  return out
}
