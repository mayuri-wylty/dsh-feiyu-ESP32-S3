// ESP32 通道：流式句切分（T19 / E 道）
//
// 目标：把 LLM 的增量文本切成可立刻送 TTS 的句子。
//   · 句末：。！？；… 与换行（ASCII !?; 一并认）
//   · 引号/标签内的句末不切（至少覆盖 「」 “” 『』 与 [ ] 【 】）
//   · 超长软上限约 60 字：优先在逗号/顿号/空格处断，避免把 [表情:…] 标签切两半
// 全部是纯函数，无网络、无时钟依赖。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SENTENCE_SOFT_LIMIT,
  splitSentences,
  createSentenceSplitter,
} from '../lib/esp32/sentence.js'

const feed = (parts, opts) => {
  const s = createSentenceSplitter(opts)
  const out = []
  for (const p of parts) out.push(...s.push(p))
  return { out, splitter: s }
}

test('整段切分：。！？；… 各自成句', () => {
  assert.deepEqual(splitSentences('你好。今天天气不错！真的吗？'), ['你好。', '今天天气不错！', '真的吗？'])
  assert.deepEqual(splitSentences('先这样；然后呢…'), ['先这样；', '然后呢…'])
  assert.deepEqual(splitSentences('Hello! How are you?'), ['Hello!', 'How are you?'])
})

test('连续句末标点不拆散：？！ / ……', () => {
  assert.deepEqual(splitSentences('真的吗？！好的……'), ['真的吗？！', '好的……'])
})

test('换行也是句界；空行与首尾空白被清理', () => {
  assert.deepEqual(splitSentences('第一行\n第二行\n\n第三行'), ['第一行', '第二行', '第三行'])
  assert.deepEqual(splitSentences('  你好。  '), ['你好。'])
  assert.deepEqual(splitSentences('   \n\t  '), [])
  assert.deepEqual(splitSentences(''), [])
})

test('中文引号内的句末不切（「」与“”）', () => {
  assert.deepEqual(
    splitSentences('他说：“你好。再见。”我走了。'),
    ['他说：“你好。再见。”', '我走了。'],
  )
  assert.deepEqual(
    splitSentences('她喊「快跑！」然后跑了。'),
    ['她喊「快跑！」', '然后跑了。'],
  )
  assert.deepEqual(
    splitSentences('旁白「他说『明天见。』就走了。」完。'),
    ['旁白「他说『明天见。』就走了。」', '完。'],
  )
})

test('引号未闭合时不提前切；flush 收尾整段吐出', () => {
  const { out, splitter } = feed(['他说：“你好。', '再见。'])
  assert.deepEqual(out, [])
  assert.deepEqual(splitter.flush(), ['他说：“你好。再见。'])
  assert.deepEqual(splitter.flush(), [])
})

test('方括号/书名号标签内的句末不切', () => {
  assert.deepEqual(splitSentences('[表情:开心]。'), ['[表情:开心]。'])
  assert.deepEqual(splitSentences('【情绪：撒娇。】好呀。'), ['【情绪：撒娇。】', '好呀。'])
})

test('流式：chunk 从任意位置切开也能正确成句', () => {
  const parts = ['你', '好', '。今', '天天气', '不错！真', '的吗？']
  const s = createSentenceSplitter()
  const got = []
  for (const p of parts) got.push(...s.push(p))
  assert.deepEqual(got, ['你好。', '今天天气不错！', '真的吗？'])
  assert.deepEqual(s.flush(), [])
})

test('软上限：无标点的超长文本按约 60 字切开，内容无损', () => {
  const text = '甲'.repeat(130)
  const got = splitSentences(text)
  assert.equal(got.length, 3)
  assert.equal(got.join(''), text)
  for (const s of got) assert.ok(s.length <= DEFAULT_SENTENCE_SOFT_LIMIT, `句子超长: ${s.length}`)
})

test('软上限优先在逗号/顿号处切，避免半句', () => {
  const text = '甲'.repeat(40) + '，' + '乙'.repeat(40)
  const got = splitSentences(text)
  assert.equal(got[0], '甲'.repeat(40) + '，')
  assert.equal(got[1], '乙'.repeat(40))
})

test('软上限不把 [表情:…] 标签切成两半', () => {
  const text = '甲'.repeat(55) + '[表情:开心]'
  const got = splitSentences(text)
  assert.equal(got.join(''), text)
  assert.ok(!got[0].includes('['), '第一段不该切开标签')
  assert.ok(got.some((s) => s === '[表情:开心]'), '标签应完整保留在后续段')
})

test('软上限保护代理对（emoji 不被劈成半个）', () => {
  const text = '甲'.repeat(59) + '😀' + '乙'.repeat(10)
  const got = splitSentences(text)
  assert.equal(got.join(''), text)
})

test('流式软上限同样生效，且 flush 幂等', () => {
  const s = createSentenceSplitter()
  const got = [...s.push('甲'.repeat(70)), ...s.push('乙'.repeat(70))]
  assert.ok(got.length >= 2)
  const rest = s.flush()
  assert.equal(got.join('') + rest.join(''), '甲'.repeat(70) + '乙'.repeat(70))
  assert.deepEqual(s.flush(), [])
})
