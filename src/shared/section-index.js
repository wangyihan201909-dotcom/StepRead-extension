/*
 * 章节索引：把一份长文档预先压成「大纲 + 每章一段摘要」。
 *
 * 为什么要预编译：全局问题（这本书的论证怎么搭起来的、前后有没有矛盾）
 * 只能看全文才答得了，而整本书塞进上下文既装不下也烧钱。把通读的成本
 * 付一次，之后每一问都只带这份索引，成本就从「每轮一本书」变成「每轮几千字」。
 *
 * 为什么不用向量检索代替：top-k 会把论证切成碎片，正好丢掉全局问题要的
 * 那个整体。摘要保留的是结构。
 *
 * 有损性是这里的硬约束：摘要把一次解读固化了下来，所以它只服务全局问题。
 * 划线提问、局部提问仍然走逐字原文，绝不用摘要顶替 —— 读者问「作者这句
 * 到底什么意思」时，能回答的只有原文本身。
 */

// 标题判定复用上下文装配那一套：自己再写一份，两边迟早会对不上
import {
  normalizeBlocks,
  getBlockText,
  isHeadingBlock,
  getHeadingLevel,
  getHeadingTitle,
  getBlockOrder
} from "./context-capabilities.js";

// 太短的章节不值得单独摘要，并进上一章更有用
const MIN_SECTION_CHARS = 400;
// 单章正文进模型前的上限，超长的章节先截断，避免一次请求过大
const MAX_SECTION_CHARS = 24_000;

/*
 * 按标题层级切章。取文档里最浅的那一级作为「章」，
 * 因为不同文档的起始层级不一样：有的从 h1 开始，有的整篇都是 h2。
 */
export function splitDocumentIntoSections(blocks = []) {
  const ordered = normalizeBlocks(blocks);
  const headings = ordered
    .map((block, index) => ({ block, index, level: getHeadingLevel(block) }))
    .filter((item) => isHeadingBlock(item.block));

  if (!headings.length) {
    const text = joinBlockText(ordered);
    return text.trim()
      ? [{ id: "section-whole", title: "全文", path: [], startIndex: 0, endIndex: ordered.length - 1, text }]
      : [];
  }

  const topLevel = Math.min(...headings.map((item) => item.level));
  const starts = headings.filter((item) => item.level === topLevel);

  const sections = [];
  starts.forEach((start, order) => {
    const nextStart = starts[order + 1];
    const endIndex = nextStart ? nextStart.index - 1 : ordered.length - 1;
    const body = ordered.slice(start.index, endIndex + 1);
    const text = joinBlockText(body);
    if (!text.trim()) {
      return;
    }
    sections.push({
      id: start.block.id ? `${start.block.id}-section` : `section-${order}`,
      title: getHeadingTitle(start.block) || `第 ${order + 1} 节`,
      path: [getHeadingTitle(start.block)].filter(Boolean),
      headingId: start.block.id || "",
      startOrder: numberOr(getBlockOrder(start.block), start.index),
      endOrder: numberOr(getBlockOrder(ordered[endIndex]), endIndex),
      startIndex: start.index,
      endIndex,
      text
    });
  });

  return mergeTinySections(sections);
}

/*
 * 极短的章（版权页、只有一行的过渡节）单独摘要没有意义，
 * 并进前一章；它是开头就并进后一章。
 */
function mergeTinySections(sections) {
  const merged = [];
  for (const section of sections) {
    const previous = merged[merged.length - 1];
    if (section.text.length < MIN_SECTION_CHARS && previous) {
      previous.text = `${previous.text}\n\n${section.text}`;
      previous.endOrder = section.endOrder;
      previous.endIndex = section.endIndex;
      continue;
    }
    merged.push({ ...section });
  }
  // 开头那一节太短且后面还有内容时，并进后一节
  if (merged.length > 1 && merged[0].text.length < MIN_SECTION_CHARS) {
    const [first, second, ...rest] = merged;
    return [
      { ...second, text: `${first.text}\n\n${second.text}`, startOrder: first.startOrder, startIndex: first.startIndex },
      ...rest
    ];
  }
  return merged;
}

export function clipSectionText(text) {
  const value = String(text || "");
  return value.length > MAX_SECTION_CHARS ? `${value.slice(0, MAX_SECTION_CHARS)}\n[后续内容略]` : value;
}

/*
 * 索引是否还配得上当前正文。重新导入或重新解析之后块会变，
 * 这时旧摘要描述的已经是另一份文本了，必须让读者看见它过期了。
 */
export function getSectionIndexSignature(blocks = []) {
  const ordered = normalizeBlocks(blocks);
  const totalChars = ordered.reduce((sum, block) => sum + getBlockText(block).length, 0);
  return `${ordered.length}:${totalChars}`;
}

export function readSectionIndex(documentRecord) {
  const index = documentRecord?.sectionIndex;
  const sections = Array.isArray(index?.sections) ? index.sections : [];
  return {
    sections,
    signature: String(index?.signature || ""),
    model: String(index?.model || ""),
    generatedAt: String(index?.generatedAt || "")
  };
}

export function getSectionIndexState(documentRecord, blocks = []) {
  const index = readSectionIndex(documentRecord);
  const expected = splitDocumentIntoSections(blocks).length;
  if (!index.sections.length) {
    return { status: "missing", done: 0, expected, index };
  }
  if (index.signature !== getSectionIndexSignature(blocks)) {
    return { status: "stale", done: index.sections.length, expected, index };
  }
  return { status: "ready", done: index.sections.length, expected, index };
}

/* 章节摘要转成 getDocumentSectionSummaries 认得的形状，接上既有的上下文装配 */
export function toSectionSummaries(documentRecord) {
  return readSectionIndex(documentRecord).sections.map((section, order) => ({
    id: section.id || `section-${order}`,
    title: section.title || "",
    path: Array.isArray(section.path) ? section.path : [],
    chapterTitle: section.title || "",
    level: 1,
    startOrder: numberOr(section.startOrder, order),
    endOrder: numberOr(section.endOrder, order),
    summary: section.summary || ""
  }));
}

function joinBlockText(blocks) {
  return blocks
    .map((block) => getBlockText(block))
    .filter(Boolean)
    .join("\n\n");
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
