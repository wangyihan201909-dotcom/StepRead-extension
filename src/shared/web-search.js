/*
 * 联网查询。
 *
 * 这里只负责「拿到候选结果」，不负责把它们塞进 prompt —— 结果要先在界面上
 * 列给读者勾选，勾中的才会作为可见的上下文条目发出去。这是这个项目的硬约束：
 * 不往模型里输入读者没过目的 context。
 *
 * 模型服务是 OpenAI-compatible 协议，但联网搜索在这个协议里没有统一做法，
 * 所以搜索走独立的服务和独立的 key，与模型供应商解耦。
 */

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_SNIPPET_CHARS = 600;

export const WEB_SEARCH_PROVIDERS = {
  tavily: {
    label: "Tavily",
    endpoint: "https://api.tavily.com/search",
    keyHint: "tvly-..."
  },
  brave: {
    label: "Brave Search",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    keyHint: "BSA..."
  }
};

export class WebSearchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "WebSearchError";
    this.status = options.status || 0;
    this.provider = options.provider || "";
    this.cause = options.cause;
  }
}

export function getWebSearchSettings(aiSettings = {}) {
  const raw = aiSettings.webSearch || {};
  const provider = WEB_SEARCH_PROVIDERS[raw.provider] ? raw.provider : "tavily";
  const maxResults = Number(raw.maxResults);
  return {
    enabled: Boolean(raw.enabled),
    provider,
    apiKey: String(raw.apiKey || ""),
    maxResults: Number.isFinite(maxResults) ? Math.min(Math.max(Math.trunc(maxResults), 1), 10) : 5
  };
}

export function isWebSearchReady(aiSettings = {}) {
  const settings = getWebSearchSettings(aiSettings);
  return settings.enabled && Boolean(settings.apiKey);
}

/* 返回统一形状：[{ title, url, snippet, source }]，失败抛 WebSearchError */
export async function searchWeb({ query, aiSettings = {}, signal, timeoutMs } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    throw new WebSearchError("搜索词是空的。");
  }

  const settings = getWebSearchSettings(aiSettings);
  if (!settings.apiKey) {
    // 没配 key 时给一条占位结果，界面流程仍然可以走通，但明确标注不是真实结果
    return [
      {
        title: `（未配置搜索 key，未真正联网）${trimmed}`,
        url: "",
        snippet:
          "设置页里填入搜索服务的 API key 之后，这里会显示真实的联网结果。当前这条只是占位，勾选它不会给模型带来任何外部信息。",
        source: "local-demo",
        demo: true
      }
    ];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SEARCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const raw =
      settings.provider === "brave"
        ? await searchBrave(trimmed, settings, controller.signal)
        : await searchTavily(trimmed, settings, controller.signal);
    return raw.slice(0, settings.maxResults);
  } catch (error) {
    if (error instanceof WebSearchError) {
      throw error;
    }
    if (error?.name === "AbortError") {
      throw new WebSearchError("联网查询超时或已取消。", { provider: settings.provider, cause: error });
    }
    throw new WebSearchError(`联网查询失败：${error?.message || error}`, {
      provider: settings.provider,
      cause: error
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function searchTavily(query, settings, signal) {
  const response = await fetch(WEB_SEARCH_PROVIDERS.tavily.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: settings.apiKey,
      query,
      max_results: settings.maxResults,
      search_depth: "basic"
    }),
    signal
  });
  await assertOk(response, "tavily");
  const payload = await response.json();
  return normalizeResults(payload?.results, (item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.content || item?.raw_content
  }));
}

async function searchBrave(query, settings, signal) {
  const url = new URL(WEB_SEARCH_PROVIDERS.brave.endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(settings.maxResults));
  const response = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": settings.apiKey },
    signal
  });
  await assertOk(response, "brave");
  const payload = await response.json();
  return normalizeResults(payload?.web?.results, (item) => ({
    title: item?.title,
    url: item?.url,
    snippet: item?.description
  }));
}

async function assertOk(response, provider) {
  if (response.ok) {
    return;
  }
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 300);
  } catch (error) {
    detail = "";
  }
  throw new WebSearchError(
    `搜索服务返回 ${response.status}${detail ? `：${detail}` : ""}`,
    { status: response.status, provider }
  );
}

/* 供应商字段各不相同，统一成同一形状，并且过滤掉没有正文的条目 */
function normalizeResults(list, pick) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      const picked = pick(item) || {};
      const url = String(picked.url || "").trim();
      return {
        title: clip(picked.title, 160) || url || "未命名结果",
        url,
        snippet: clip(picked.snippet, MAX_SNIPPET_CHARS),
        source: hostOf(url)
      };
    })
    .filter((item) => item.snippet || item.url);
}

function clip(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    return "";
  }
}
