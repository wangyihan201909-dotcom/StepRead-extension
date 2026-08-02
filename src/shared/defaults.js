export const STORAGE_KEYS = {
  settings: "settings"
};

export const DEFAULT_SETTINGS = {
  ai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    demoMode: true,
    /*
     * 联网查询：搜到的结果不会自动进 prompt，先列出来由读者勾选，
     * 勾中的才作为可见的上下文条目发出去。搜索服务和模型服务是两个 key。
     */
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "",
      maxResults: 5
    },
    context: {
      selection: {
        neighborBlockCount: 1,
        includeDocumentOutline: true,
        includeChapterTitle: true,
        includeSelectedBlock: true,
        includeAdjacentBlocks: true,
        includeCurrentChapterBlocks: false,
        includeThreadHistory: true,
        chapterTextScope: "none",
        sectionSummaryScope: "none",
        qaHistoryScope: "current-thread"
      },
      knowledge: {
        neighborBlockCount: 0,
        includeDocumentOutline: true,
        includeChapterTitle: true,
        includeSelectedBlock: true,
        includeAdjacentBlocks: false,
        includeCurrentChapterBlocks: false,
        includeThreadHistory: true,
        includeKnowledgeHighlights: true,
        includeFullText: false,
        fullTextScope: "none",
        sectionSummaryScope: "none",
        qaHistoryScope: "all-highlights"
      }
    },
    systemPrompt:
      "你是 StepRead 的划线阅读助手。请优先依据读者选中的原文和可用上下文，直接回答读者的问题；如果依据不足，请说“这段文字和上下文不足以判断”，不要编造。",
    selectionPrompt:
      "请直接回答读者的问题。\n\n划线原文：\n{{selection}}\n\n读者问题：\n{{question}}\n\n仅供助手参考的材料：\n{{context}}"
  },
  reader: {
    lastDocumentId: "",
    fontFamily: "system",
    preferredFontSize: 17,
    theme: "light",
    // 联网查询是个开关：打开之后每次提问自动检索，不需要手动搜再挑
    webSearchEnabled: false,
    documentFolders: []
  },
  knowledgeGraph: {
    // 切片和连线都由读者手动建立，所以默认不自动连线；设置页仍可改回 sequence
    autoLinkMode: "none",
    cardBody: "summary",
    cardBodyLimit: 160,
    chatContextScope: "summary-and-all",
    layout: {
      repulsion: 26000,
      linkDistance: 240,
      centerGravity: 0.035
    }
  }
};

export const DB_NAME = "edge-mv3-reader-db";
export const DB_VERSION = 5;

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function deepMerge(defaults, override) {
  if (!override || typeof override !== "object") {
    return structuredCloneIfAvailable(defaults);
  }

  const result = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    const defaultValue = defaults?.[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      defaultValue &&
      typeof defaultValue === "object" &&
      !Array.isArray(defaultValue)
    ) {
      result[key] = deepMerge(defaultValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function structuredCloneIfAvailable(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}
