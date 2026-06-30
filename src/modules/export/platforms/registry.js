// 由同步脚本自动重写生成，只引入当前平台的提取逻辑
import {
  PLATFORM_GEMINI,
  detectPlatform
} from '../utils.js';
import { parseGeminiMessages } from './gemini/extractor.js';

export var PLATFORM_EXPORT_REGISTRY = {
  gemini: {
    id: PLATFORM_GEMINI,
    label: "Gemini",
    parseMessages: parseGeminiMessages
  }
};

export function getPlatformAdapter(platform) {
  return PLATFORM_EXPORT_REGISTRY[platform || detectPlatform()] || null;
}

export function parseMessagesForPlatform(platform) {
  var adapter = getPlatformAdapter(platform);
  return adapter && typeof adapter.parseMessages === "function"
    ? adapter.parseMessages()
    : [];
}

export function getRegisteredExportPlatforms() {
  return Object.keys(PLATFORM_EXPORT_REGISTRY);
}
