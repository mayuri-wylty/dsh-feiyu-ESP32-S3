// T15：ESP32 第五通道 ASR provider 入口。
// 具体实现见同目录 sensevoice.js / openai.js / fallback.js；契约见 ../contracts.js。
export { createAsrProviderFromConfig, createFallbackAsrProvider } from './fallback.js'
export { createSensevoiceProvider, SENSEVOICE_PROVIDER_ID } from './sensevoice.js'
export {
  createOpenAICompatibleProvider,
  normalizeTranscriptionUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  DEFAULT_ASR_TIMEOUT_MS,
} from './openai.js'
