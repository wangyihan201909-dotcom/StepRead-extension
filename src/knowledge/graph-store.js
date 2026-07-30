import { createId, nowIso } from "../shared/defaults.js";
import { dbDelete, dbGetAllByIndex, dbPut, dbPutMany } from "../shared/db.js";

export const AUTO_EDGE_ORIGINS = new Set(["auto-sequence", "auto-thread"]);
const UNDO_STACK_LIMIT = 20;

export async function loadGraph(documentId) {
  const [nodes, edges] = await Promise.all([
    dbGetAllByIndex("graphNodes", "by_documentId", documentId),
    dbGetAllByIndex("graphEdges", "by_documentId", documentId)
  ]);
  return {
    nodes: sortNodes(nodes),
    edges: sortEdges(edges)
  };
}

/**
 * Rebuilds the derived part of the graph from the reading records.
 *
 * Content fields of existing nodes are refreshed, but layout fields (x/y/pinned)
 * and every user edit stay untouched. Auto edges the user deleted keep their
 * tombstone so reconciling never resurrects them.
 */
export async function reconcileGraph({
  documentId,
  nodes = [],
  edges = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  blocks = [],
  settings = {}
} = {}) {
  const autoLinkMode = settings?.knowledgeGraph?.autoLinkMode || "sequence";
  const turns = collectQaTurns({ highlights, threads, messagesByThread, summaries, blocks });
  const nodesBySourceKey = new Map(
    nodes.filter((node) => node.kind === "qa" && node.sourceKey).map((node) => [node.sourceKey, node])
  );
  // A slice hand-converted from an orphaned Q&A turn must not reappear as a qa
  // node, and converting must not duplicate its user-drawn edges onto a new node.
  const convertedSourceKeys = new Set(
    nodes.filter((node) => node.kind === "note" && node.sourceKey).map((node) => node.sourceKey)
  );
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const nextNodes = [...nodes];
  const changedNodes = [];
  const orderedQaNodes = [];

  for (const [index, turn] of turns.entries()) {
    const existing = nodesBySourceKey.get(turn.sourceKey);
    if (existing) {
      const merged = mergeQaNode(existing, turn, index);
      if (merged !== existing) {
        changedNodes.push(merged);
        replaceInArray(nextNodes, merged);
      }
      if (!merged.hidden) {
        orderedQaNodes.push(merged);
      }
      continue;
    }
    if (convertedSourceKeys.has(turn.sourceKey)) {
      continue;
    }

    const created = createQaNode(documentId, turn, index);
    changedNodes.push(created);
    nextNodes.push(created);
    orderedQaNodes.push(created);
  }

  const liveSourceKeys = new Set(turns.map((turn) => turn.sourceKey));
  for (const node of nextNodes) {
    if (node.kind !== "qa" || node.hidden || liveSourceKeys.has(node.sourceKey)) {
      continue;
    }
    if (node.orphan) {
      continue;
    }
    const orphaned = { ...node, orphan: true, updatedAt: nowIso() };
    changedNodes.push(orphaned);
    replaceInArray(nextNodes, orphaned);
  }

  const nextEdges = [...edges];
  const changedEdges = [];
  const edgeKeys = new Set(edges.map((edge) => createEdgeKey(edge.fromNodeId, edge.toNodeId)));

  if (autoLinkMode !== "none") {
    const lastNodeByThread = new Map();
    let previousNode = null;

    for (const node of orderedQaNodes) {
      const threadPrevious = node.threadId ? lastNodeByThread.get(node.threadId) : null;
      const source = threadPrevious || (autoLinkMode === "thread-only" ? null : previousNode);
      const origin = threadPrevious ? "auto-thread" : "auto-sequence";

      if (source && source.id !== node.id) {
        const key = createEdgeKey(source.id, node.id);
        const reverseKey = createEdgeKey(node.id, source.id);
        if (!edgeKeys.has(key) && !edgeKeys.has(reverseKey)) {
          const edge = makeEdge({
            documentId,
            fromNodeId: source.id,
            toNodeId: node.id,
            origin,
            relation: origin === "auto-thread" ? "追问" : "接着问"
          });
          edgeKeys.add(key);
          changedEdges.push(edge);
          nextEdges.push(edge);
        }
      }

      if (node.threadId) {
        lastNodeByThread.set(node.threadId, node);
      }
      previousNode = node;
    }
  }

  if (changedNodes.length) {
    await dbPutMany("graphNodes", changedNodes);
  }
  if (changedEdges.length) {
    await dbPutMany("graphEdges", changedEdges);
  }

  return {
    nodes: sortNodes(nextNodes),
    edges: sortEdges(nextEdges),
    createdNodeIds: changedNodes.filter((node) => !knownNodeIds.has(node.id)).map((node) => node.id),
    changed: Boolean(changedNodes.length || changedEdges.length)
  };
}

export function collectQaTurns({ highlights = [], threads = [], messagesByThread = {}, summaries = [], blocks = [] }) {
  const highlightsById = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const summariesByMessageId = new Map(
    summaries.filter((summary) => summary?.messageId).map((summary) => [summary.messageId, summary])
  );
  const chapterTitlesByBlockId = createChapterTitleLookup(blocks);
  const turns = [];

  for (const thread of threads) {
    const messages = sortMessages(messagesByThread[thread.id] || []);
    const highlight = highlightsById.get(thread.highlightId) || null;
    let pendingUserMessage = null;

    for (const message of messages) {
      if (message.role === "user") {
        pendingUserMessage = message;
        continue;
      }
      if (message.role !== "assistant") {
        continue;
      }

      const userMessage = pendingUserMessage;
      pendingUserMessage = null;
      turns.push({
        sourceKey: message.id,
        threadId: thread.id,
        highlightId: thread.highlightId || "",
        blockId: highlight?.blockId || "",
        question: String(userMessage?.content || "").trim(),
        answer: String(message.content || "").trim(),
        summary: String(summariesByMessageId.get(message.id)?.text || "").trim(),
        quote: String(highlight?.text || "").trim(),
        chapterTitle: chapterTitlesByBlockId.get(highlight?.blockId) || "",
        threadTitle: String(thread.title || "").trim(),
        model: String(message.model || ""),
        askedAt: userMessage?.createdAt || message.createdAt || "",
        answeredAt: message.createdAt || ""
      });
    }
  }

  return turns.sort(
    (a, b) =>
      String(a.askedAt).localeCompare(String(b.askedAt)) || String(a.sourceKey).localeCompare(String(b.sourceKey))
  );
}

export async function createNoteNode({ documentId, x = 0, y = 0, title = "", body = "" }) {
  const createdAt = nowIso();
  const node = {
    id: createId("gnode"),
    documentId,
    kind: "note",
    sourceKey: "",
    threadId: "",
    highlightId: "",
    blockId: "",
    order: Number.MAX_SAFE_INTEGER,
    title: title || "新切片",
    question: "",
    answer: "",
    summary: "",
    quote: "",
    body,
    chapterTitle: "",
    x,
    y,
    pinned: true,
    collapsed: false,
    color: "",
    orphan: false,
    hidden: false,
    createdAt,
    updatedAt: createdAt
  };
  await dbPut("graphNodes", node);
  return node;
}

export async function createGraphQaNode({ documentId, question, answer, x = 0, y = 0, model = "" }) {
  const createdAt = nowIso();
  const node = {
    id: createId("gnode"),
    documentId,
    kind: "graph-qa",
    sourceKey: "",
    threadId: "",
    highlightId: "",
    blockId: "",
    order: Number.MAX_SAFE_INTEGER,
    title: createNodeTitle(question),
    question: String(question || "").trim(),
    answer: String(answer || "").trim(),
    summary: "",
    quote: "",
    body: "",
    chapterTitle: "",
    model,
    x,
    y,
    pinned: true,
    collapsed: false,
    color: "",
    orphan: false,
    hidden: false,
    createdAt,
    updatedAt: createdAt
  };
  await dbPut("graphNodes", node);
  return node;
}

export async function saveNode(node) {
  const next = { ...node, updatedAt: nowIso() };
  await dbPut("graphNodes", next);
  return next;
}

export async function saveNodePositions(nodes) {
  const records = nodes.filter(Boolean);
  if (!records.length) {
    return;
  }
  await dbPutMany("graphNodes", records);
}

/**
 * Slices derived from a Q&A turn keep a hidden tombstone so reconciling will not
 * recreate them from the reading records. Hand-made slices are removed outright.
 */
export async function deleteNodeCascade({ node, edges = [] }) {
  const touchedEdges = edges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id);
  await Promise.all(touchedEdges.map((edge) => dbDelete("graphEdges", edge.id)));

  if (node.kind === "qa") {
    const hidden = { ...node, hidden: true, updatedAt: nowIso() };
    await dbPut("graphNodes", hidden);
    return { removedEdgeIds: touchedEdges.map((edge) => edge.id), node: hidden };
  }

  await dbDelete("graphNodes", node.id);
  return { removedEdgeIds: touchedEdges.map((edge) => edge.id), node: null };
}

/**
 * Turns an orphaned Q&A slice into a hand-made one. The node keeps its id and
 * coordinates so user-drawn edges stay attached; the old sourceKey is kept so
 * reconciling never recreates a second qa node for the same turn.
 */
export async function convertNodeToNote(node) {
  const converted = {
    ...node,
    kind: "note",
    orphan: false,
    pinned: true,
    titleEdited: true,
    updatedAt: nowIso()
  };
  await dbPut("graphNodes", converted);
  return converted;
}

export function getVisibleNodes(nodes) {
  return nodes.filter((node) => !node.hidden);
}

export async function createUserEdge({ documentId, fromNodeId, toNodeId, relation = "" }) {
  const edge = makeEdge({
    documentId,
    fromNodeId,
    toNodeId,
    origin: "user",
    relation,
    confirmed: true
  });
  await dbPut("graphEdges", edge);
  return edge;
}

export async function saveEdge(edge) {
  const next = { ...edge, updatedAt: nowIso() };
  await dbPut("graphEdges", next);
  return next;
}

/**
 * Auto edges become tombstones so reconciling will not recreate them.
 * User edges are removed outright.
 */
export async function removeEdge(edge) {
  if (AUTO_EDGE_ORIGINS.has(edge.origin)) {
    const tombstone = { ...edge, removed: true, confirmed: false, updatedAt: nowIso() };
    await dbPut("graphEdges", tombstone);
    return { edge: tombstone, deleted: false };
  }
  await dbDelete("graphEdges", edge.id);
  return { edge: null, deleted: true };
}

export function getVisibleEdges(edges) {
  return edges.filter((edge) => !edge.removed);
}

export function snapshotGraph({ nodes = [], edges = [] }) {
  return {
    nodes: nodes.map((node) => ({ ...node })),
    edges: edges.map((edge) => ({ ...edge }))
  };
}

export async function restoreGraphSnapshot(documentId, snapshot) {
  const current = await loadGraph(documentId);
  const keptNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const keptEdgeIds = new Set(snapshot.edges.map((edge) => edge.id));

  await Promise.all([
    ...current.nodes.filter((node) => !keptNodeIds.has(node.id)).map((node) => dbDelete("graphNodes", node.id)),
    ...current.edges.filter((edge) => !keptEdgeIds.has(edge.id)).map((edge) => dbDelete("graphEdges", edge.id))
  ]);

  if (snapshot.nodes.length) {
    await dbPutMany("graphNodes", snapshot.nodes);
  }
  if (snapshot.edges.length) {
    await dbPutMany("graphEdges", snapshot.edges);
  }

  return snapshotGraph(snapshot);
}

export function createUndoStack(limit = UNDO_STACK_LIMIT) {
  const entries = [];
  return {
    push(snapshot) {
      entries.push(snapshot);
      while (entries.length > limit) {
        entries.shift();
      }
    },
    pop() {
      return entries.pop() || null;
    },
    get size() {
      return entries.length;
    },
    clear() {
      entries.length = 0;
    }
  };
}

export function createGraphSignaturePayload({ nodes = [], edges = [] } = {}) {
  return {
    nodes: sortNodes(nodes).map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title || "",
      body: node.body || "",
      orphan: Boolean(node.orphan),
      sourceKey: node.sourceKey || ""
    })),
    edges: sortEdges(getVisibleEdges(edges)).map((edge) => ({
      id: edge.id,
      from: edge.fromNodeId,
      to: edge.toNodeId,
      origin: edge.origin,
      relation: edge.relation || "",
      confirmed: Boolean(edge.confirmed)
    }))
  };
}

export function sortMessages(messages) {
  return [...messages].sort(
    (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
  );
}

export function createNodeTitle(text, limit = 38) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "未命名切片";
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function createQaNode(documentId, turn, index) {
  const createdAt = turn.answeredAt || nowIso();
  return {
    id: createId("gnode"),
    documentId,
    kind: "qa",
    sourceKey: turn.sourceKey,
    threadId: turn.threadId,
    highlightId: turn.highlightId,
    blockId: turn.blockId,
    order: index,
    title: createNodeTitle(turn.question || turn.threadTitle),
    question: turn.question,
    answer: turn.answer,
    summary: turn.summary,
    quote: turn.quote,
    body: "",
    chapterTitle: turn.chapterTitle,
    model: turn.model,
    x: null,
    y: null,
    pinned: false,
    collapsed: false,
    color: "",
    orphan: false,
    hidden: false,
    createdAt,
    updatedAt: createdAt
  };
}

function mergeQaNode(existing, turn, index) {
  const patch = {
    order: index,
    question: turn.question,
    answer: turn.answer,
    summary: turn.summary,
    quote: turn.quote,
    chapterTitle: turn.chapterTitle,
    threadId: turn.threadId,
    highlightId: turn.highlightId,
    blockId: turn.blockId,
    orphan: false
  };
  const hasChange = Object.entries(patch).some(([key, value]) => existing[key] !== value);
  if (!hasChange) {
    return existing;
  }

  // A user-renamed title stays; auto titles follow the current question.
  const nextTitle = existing.titleEdited ? existing.title : createNodeTitle(turn.question || turn.threadTitle);
  return { ...existing, ...patch, title: nextTitle, updatedAt: nowIso() };
}

function makeEdge({ documentId, fromNodeId, toNodeId, origin, relation = "", confirmed = false }) {
  const createdAt = nowIso();
  return {
    id: createId("gedge"),
    documentId,
    fromNodeId,
    toNodeId,
    origin,
    relation,
    confirmed,
    removed: false,
    createdAt,
    updatedAt: createdAt
  };
}

function createEdgeKey(fromNodeId, toNodeId) {
  return `${fromNodeId}=>${toNodeId}`;
}

function replaceInArray(list, record) {
  const index = list.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    list[index] = record;
  }
}

function createChapterTitleLookup(blocks) {
  const ordered = [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const lookup = new Map();
  const headingStack = [];

  for (const block of ordered) {
    if (isHeadingBlock(block)) {
      const level = Number(block.level) || 1;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      const title = String(block.text || block.title || "").trim();
      if (title) {
        headingStack.push({ level, title });
      }
    }
    lookup.set(block.id, headingStack.map((heading) => heading.title).join(" > "));
  }

  return lookup;
}

function isHeadingBlock(block) {
  return block?.type === "heading" || block?.type === "title";
}

function sortNodes(nodes) {
  return [...nodes].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
  );
}

function sortEdges(edges) {
  return [...edges].sort(
    (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
  );
}
