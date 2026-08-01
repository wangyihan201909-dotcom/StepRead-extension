import { nowIso } from "../shared/defaults.js";
import { dbGetAllByIndex, dbPut, deleteQaTurnRecords, getDocumentWithBlocks } from "../shared/db.js";
import { getSettings } from "../shared/store.js";
import { generateGraphGreeting, generateKnowledgeReport, suggestEdgeRelation } from "../shared/ai-client.js";
import { createKnowledgeReportSignature } from "../shared/knowledge-signature.js";
import { markdownToBlocks } from "../shared/markdown.js";
import { renderBlocks } from "../shared/block-renderer.js";
import { renderMessageContent } from "../shared/rich-text.js";
import { openOrFocusExtensionPage } from "../shared/navigation.js";
import {
  collectAcceptedEvidence,
  collectQaTurns,
  convertNodeToNote,
  createGraphQaNode,
  createGraphSignaturePayload,
  createNodeTitle,
  createNoteNode,
  createUndoStack,
  createUserEdge,
  deleteNodeCascade,
  getVisibleEdges,
  getVisibleNodes,
  loadGraph,
  placeQaTurnNode,
  reconcileGraph,
  removeEdge,
  restoreGraphSnapshot,
  saveEdge,
  saveNode,
  saveNodePositions,
  snapshotGraph,
  sortMessages
} from "./graph-store.js";
import {
  NODE_SIZE,
  findFreeSpot,
  resolveLayoutOptions,
  runLayout,
  runTimelineLayout,
  seedMissingPositions
} from "./graph-layout.js";
import { EVIDENCE_DRAG_TYPE, createGraphView } from "./graph-view.js";
import { createGraphChat } from "./graph-chat.js";

const KNOWLEDGE_REFRESH_KEY = "knowledgeRefreshSignal";
const KNOWLEDGE_UI_KEY = "knowledgeGraphUi";
const KNOWLEDGE_REFRESH_DEBOUNCE_MS = 320;
const KNOWLEDGE_GENERATION_TIMEOUT_MS = 300_000;
const KNOWLEDGE_GENERATION_STAGES = [
  { minElapsedSeconds: 0, label: "整理切片与关联" },
  { minElapsedSeconds: 2, label: "生成结构化摘要" },
  { minElapsedSeconds: 5, label: "等待模型返回" }
];
const params = new URLSearchParams(location.search);
const documentId = params.get("documentId") || "";

const state = {
  documentRecord: null,
  blocks: [],
  highlights: [],
  threads: [],
  messagesByThread: {},
  summaries: [],
  settings: null,
  nodes: [],
  edges: [],
  selectedNodeId: "",
  selectedEdgeId: "",
  // 摘要不再是页面主角：问候语在图谱问答里，长摘要默认收起
  summaryCollapsed: true,
  chatCollapsed: false,
  evidenceCollapsed: true
};

const generationProgress = {
  timerId: 0,
  startedAtMs: 0,
  streamContent: "",
  streamRenderQueued: false,
  streamRenderedContent: ""
};

const undoStack = createUndoStack();
let knowledgeLoadSeq = 0;
let knowledgeRefreshTimer = 0;
let graphView = null;
let graphChat = null;

const elements = {
  documentTitle: document.querySelector("#documentTitle"),
  summaryPanel: document.querySelector("#summaryPanel"),
  summaryToggle: document.querySelector("#summaryToggle"),
  summaryBody: document.querySelector("#summaryBody"),
  summaryMeta: document.querySelector("#summaryMeta"),
  summaryStaleBanner: document.querySelector("#summaryStaleBanner"),
  summaryStaleText: document.querySelector("#summaryStaleText"),
  staleRegenerateButton: document.querySelector("#staleRegenerateButton"),
  regenerateButton: document.querySelector("#regenerateButton"),
  userPrompt: document.querySelector("#userPrompt"),
  reportOutput: document.querySelector("#reportOutput"),
  status: document.querySelector("#status"),
  evidenceDrawer: document.querySelector("#evidenceDrawer"),
  evidenceToggle: document.querySelector("#evidenceToggle"),
  evidenceList: document.querySelector("#evidenceList"),
  highlightCount: document.querySelector("#highlightCount"),
  threadCount: document.querySelector("#threadCount"),
  messageCount: document.querySelector("#messageCount"),
  nodeCount: document.querySelector("#nodeCount"),
  graphCanvas: document.querySelector("#graphCanvas"),
  graphEmpty: document.querySelector("#graphEmpty"),
  addNodeButton: document.querySelector("#addNodeButton"),
  relayoutButton: document.querySelector("#relayoutButton"),
  timelineButton: document.querySelector("#timelineButton"),
  fitButton: document.querySelector("#fitButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  undoButton: document.querySelector("#undoButton"),
  reloadButton: document.querySelector("#reloadButton"),
  nodeDetail: document.querySelector("#nodeDetail"),
  nodeDetailTitle: document.querySelector("#nodeDetailTitle"),
  nodeDetailMeta: document.querySelector("#nodeDetailMeta"),
  nodeDetailQuoteSection: document.querySelector("#nodeDetailQuoteSection"),
  nodeDetailQuote: document.querySelector("#nodeDetailQuote"),
  nodeDetailQuestionSection: document.querySelector("#nodeDetailQuestionSection"),
  nodeDetailQuestion: document.querySelector("#nodeDetailQuestion"),
  nodeDetailAnswerSection: document.querySelector("#nodeDetailAnswerSection"),
  nodeDetailAnswer: document.querySelector("#nodeDetailAnswer"),
  nodeDetailEditSection: document.querySelector("#nodeDetailEditSection"),
  nodeDetailTitleInput: document.querySelector("#nodeDetailTitleInput"),
  nodeDetailBodyInput: document.querySelector("#nodeDetailBodyInput"),
  nodeDetailSave: document.querySelector("#nodeDetailSave"),
  nodeDetailFocus: document.querySelector("#nodeDetailFocus"),
  nodeDetailLocate: document.querySelector("#nodeDetailLocate"),
  nodeDetailConvert: document.querySelector("#nodeDetailConvert"),
  nodeDetailDelete: document.querySelector("#nodeDetailDelete"),
  nodeDetailClose: document.querySelector("#nodeDetailClose"),
  edgePopover: document.querySelector("#edgePopover"),
  edgePopoverMeta: document.querySelector("#edgePopoverMeta"),
  edgeRelationInput: document.querySelector("#edgeRelationInput"),
  edgeConfirmButton: document.querySelector("#edgeConfirmButton"),
  edgeSuggestButton: document.querySelector("#edgeSuggestButton"),
  edgeReverseButton: document.querySelector("#edgeReverseButton"),
  edgeDeleteButton: document.querySelector("#edgeDeleteButton"),
  chatPanel: document.querySelector("#chatPanel"),
  chatCollapseButton: document.querySelector("#chatCollapseButton"),
  chatBody: document.querySelector("#chatBody"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatSendButton: document.querySelector("#chatSendButton"),
  chatStopButton: document.querySelector("#chatStopButton"),
  chatClearButton: document.querySelector("#chatClearButton"),
  chatStatus: document.querySelector("#chatStatus"),
  chatMessages: document.querySelector("#chatMessages"),
  chatFocusList: document.querySelector("#chatFocusList")
};

init();

function init() {
  graphView = createGraphView({
    container: elements.graphCanvas,
    callbacks: {
      onSelectNode: openNodeDetail,
      onNodeMoved: handleNodeMoved,
      onConnect: handleConnect,
      onSelectEdge: openEdgePopover,
      onCanvasClick: clearSelection,
      onCanvasDoubleClick: handleCanvasDoubleClick,
      onEvidenceDrop: handleEvidenceDrop
    }
  });

  graphChat = createGraphChat({
    elements,
    documentId,
    callbacks: {
      getGraphContext: () => ({
        documentRecord: state.documentRecord,
        report: state.documentRecord?.knowledgeReport?.content || "",
        nodes: getGraphNodes(),
        edges: getGraphEdges(),
        settings: state.settings
      }),
      onAddToGraph: handleAddChatAnswerToGraph,
      onFocusChange: () => renderGraph()
    }
  });

  bindToolbar();
  bindSummaryPanel();
  bindNodeDetail();
  bindEdgePopover();
  bindExternalRefresh();
  restoreUiState();
  loadKnowledgeData();
}

function bindToolbar() {
  elements.reloadButton.addEventListener("click", () => loadKnowledgeData());
  elements.addNodeButton.addEventListener("click", () => handleCanvasDoubleClick(null));
  elements.relayoutButton.addEventListener("click", handleRelayout);
  elements.timelineButton.addEventListener("click", handleTimelineLayout);
  elements.fitButton.addEventListener("click", () => graphView.fit());
  elements.zoomInButton.addEventListener("click", () => graphView.zoomBy(1.2));
  elements.zoomOutButton.addEventListener("click", () => graphView.zoomBy(1 / 1.2));
  elements.undoButton.addEventListener("click", handleUndo);
  elements.evidenceToggle.addEventListener("click", () => setEvidenceCollapsed(!state.evidenceCollapsed));
  elements.evidenceList.addEventListener("click", handleEvidenceClick);
  elements.chatCollapseButton.addEventListener("click", () => setChatCollapsed(!state.chatCollapsed));
  document.addEventListener("keydown", handleGlobalKeydown);
}

function bindSummaryPanel() {
  // 摘要现在是 <details>，展开与否以它自己的 open 为准
  elements.summaryBody.addEventListener("toggle", () => setSummaryCollapsed(!elements.summaryBody.open));
  elements.regenerateButton.addEventListener("click", handleGenerateReport);
  elements.staleRegenerateButton.addEventListener("click", handleGenerateReport);
  elements.userPrompt.addEventListener("input", () => void refreshSummaryFreshness());
}

function bindNodeDetail() {
  elements.nodeDetailClose.addEventListener("click", closeNodeDetail);
  elements.nodeDetailSave.addEventListener("click", handleSaveNodeEdits);
  elements.nodeDetailDelete.addEventListener("click", handleDeleteNode);
  elements.nodeDetailLocate.addEventListener("click", handleLocateInReader);
  elements.nodeDetailConvert.addEventListener("click", handleConvertToNote);
  elements.nodeDetailFocus.addEventListener("click", () => {
    if (!state.selectedNodeId) {
      return;
    }
    graphChat.addFocusNode(state.selectedNodeId);
    setChatCollapsed(false);
  });
}

/* 魔法棒：让模型给一个关系短语当起点，填进输入框，仍由读者确认后才保存 */
async function handleSuggestRelation() {
  const edge = state.edges.find((item) => item.id === state.selectedEdgeId);
  if (!edge) {
    return;
  }

  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const button = elements.edgeSuggestButton;
  button.disabled = true;
  button.classList.add("busy");
  try {
    const result = await suggestEdgeRelation({
      documentRecord: state.documentRecord,
      fromNode: nodesById.get(edge.fromNodeId),
      toNode: nodesById.get(edge.toNodeId),
      aiSettings: state.settings?.ai
    });
    if (result?.ok && result.content) {
      // 模型偶尔会带标点或多说一句，这里收一下并保持在 maxlength 之内
      const phrase = String(result.content).replace(/\s+/g, " ").replace(/^["“”'']|["“”'']$/g, "").trim().slice(0, 40);
      elements.edgeRelationInput.value = phrase;
      elements.edgeRelationInput.focus();
      elements.edgeRelationInput.select();
      setStatus(result.demo ? "当前是 demo 模式，给的是占位短语。" : "这是 AI 的建议，可以改完再保存。");
    } else {
      setStatus(result?.error || "没能拿到关系建议。");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}

function bindEdgePopover() {
  elements.edgeConfirmButton.addEventListener("click", handleSaveEdge);
  elements.edgeSuggestButton.addEventListener("click", handleSuggestRelation);
  elements.edgeReverseButton.addEventListener("click", handleReverseEdge);
  elements.edgeDeleteButton.addEventListener("click", handleDeleteEdge);
  document.addEventListener("pointerdown", (event) => {
    if (elements.edgePopover.hidden) {
      return;
    }
    if (elements.edgePopover.contains(event.target) || event.target.closest?.(".graph-edge")) {
      return;
    }
    closeEdgePopover();
  });
}

function bindExternalRefresh() {
  if (!globalThis.chrome?.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    const signal = changes[KNOWLEDGE_REFRESH_KEY]?.newValue;
    if (signal?.documentId !== documentId) {
      return;
    }
    scheduleKnowledgeRefresh();
  });
}

function scheduleKnowledgeRefresh() {
  globalThis.clearTimeout(knowledgeRefreshTimer);
  knowledgeRefreshTimer = globalThis.setTimeout(() => {
    knowledgeRefreshTimer = 0;
    void loadKnowledgeData({ external: true });
  }, KNOWLEDGE_REFRESH_DEBOUNCE_MS);
}

async function loadKnowledgeData(options = {}) {
  if (!documentId) {
    setStatus("URL 中缺少 documentId，无法读取阅读记录。");
    setBusy(true);
    return;
  }

  const loadSeq = ++knowledgeLoadSeq;
  const generating = isKnowledgeGenerating();
  setBusy(true, generating ? "" : options.external ? "阅读记录已更新，正在同步图谱..." : "正在读取阅读记录...");
  try {
    const [{ document, blocks }, highlights, threads, summaries, settings, graph] = await Promise.all([
      getDocumentWithBlocks(documentId),
      dbGetAllByIndex("highlights", "by_documentId", documentId),
      dbGetAllByIndex("threads", "by_documentId", documentId),
      dbGetAllByIndex("summaries", "by_documentId", documentId),
      getSettings(),
      loadGraph(documentId)
    ]);

    if (!document) {
      throw new Error("IndexedDB 中没有找到这个 documentId 对应的文档。");
    }
    if (loadSeq !== knowledgeLoadSeq) {
      return;
    }

    state.documentRecord = document;
    state.blocks = blocks;
    state.highlights = highlights;
    state.threads = threads;
    state.messagesByThread = await loadMessagesByThread(threads);
    state.summaries = sortSummaries(summaries);
    state.settings = settings;

    const reconciled = await reconcileGraph({
      documentId,
      nodes: graph.nodes,
      edges: graph.edges,
      highlights,
      threads,
      messagesByThread: state.messagesByThread,
      summaries: state.summaries,
      blocks,
      settings
    });
    state.nodes = reconciled.nodes;
    state.edges = reconciled.edges;

    await layoutNewNodes(reconciled.createdNodeIds);

    if (!options.external) {
      undoStack.clear();
      updateUndoButton();
    }

    renderDocumentState();
    renderGraph();
    if (!options.external) {
      requestAnimationFrame(() => graphView.fit());
    }
    graphChat.pruneFocusNodes(getGraphNodes().map((node) => node.id));
    if (!options.external) {
      await graphChat.load();
      // 打开知识图谱时生成开场问候语（不阻塞页面，失败就不显示）
      void refreshGraphGreeting();
    } else {
      graphChat.renderFocusList();
    }

    if (!isKnowledgeGenerating()) {
      await renderCachedReportState();
    }
  } catch (error) {
    if (loadSeq !== knowledgeLoadSeq) {
      return;
    }
    setStatus(error instanceof Error ? error.message : String(error));
    elements.reportOutput.textContent = "读取失败。";
  } finally {
    if (loadSeq === knowledgeLoadSeq) {
      setBusy(false);
    }
  }
}

async function loadMessagesByThread(threads) {
  const entries = await Promise.all(
    threads.map(async (thread) => {
      const messages = await dbGetAllByIndex("messages", "by_threadId", thread.id);
      return [thread.id, sortMessages(messages)];
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Only nodes without coordinates are laid out, and only they (plus their direct
 * neighbours) may move, so arriving slices never scramble an arrangement the
 * reader already made.
 */
async function layoutNewNodes(createdNodeIds = []) {
  const visibleNodes = getGraphNodes();
  const seeded = seedMissingPositions(visibleNodes);
  const mobile = new Set([...seeded, ...createdNodeIds]);
  if (!mobile.size) {
    return;
  }

  for (const edge of getGraphEdges()) {
    if (mobile.has(edge.fromNodeId)) {
      mobile.add(edge.toNodeId);
    }
    if (mobile.has(edge.toNodeId)) {
      mobile.add(edge.fromNodeId);
    }
  }

  runLayout(visibleNodes, getGraphEdges(), {
    ...resolveLayoutOptions(state.settings),
    mobileIds: mobile
  });
  await saveNodePositions(visibleNodes.filter((node) => mobile.has(node.id)));
}

function getGraphNodes() {
  return getVisibleNodes(state.nodes);
}

function getGraphEdges() {
  const visibleNodeIds = new Set(getGraphNodes().map((node) => node.id));
  return getVisibleEdges(state.edges).filter(
    (edge) => visibleNodeIds.has(edge.fromNodeId) && visibleNodeIds.has(edge.toNodeId)
  );
}

function renderGraph() {
  const nodes = getGraphNodes();
  elements.graphEmpty.hidden = nodes.length > 0;
  graphView.render({
    nodes,
    edges: getGraphEdges(),
    selectedNodeId: state.selectedNodeId,
    selectedEdgeId: state.selectedEdgeId,
    focusNodeIds: graphChat.getFocusNodeIds(),
    cardBody: state.settings?.knowledgeGraph?.cardBody || "summary",
    cardBodyLimit: state.settings?.knowledgeGraph?.cardBodyLimit || 160
  });
  elements.nodeCount.textContent = String(nodes.length);
}

function renderDocumentState() {
  elements.documentTitle.textContent = state.documentRecord?.title || "未命名文档";
  elements.highlightCount.textContent = String(state.highlights.length);
  elements.threadCount.textContent = String(state.threads.length);
  elements.messageCount.textContent = String(getMessageCount());
  renderEvidenceList();
}

/*
 * 阅读证据列的是「在阅读器里确认过加入知识图谱」的轮次，不是画布上的切片。
 * 未放置的可以拖到画布上成为切片；已放置的留在列表里并标出来，点一下定位。
 */
/* 开场问候语：≤50 字，每次打开重新生成，不落库，失败就静默跳过 */
async function refreshGraphGreeting() {
  try {
    const result = await generateGraphGreeting({
      documentRecord: state.documentRecord,
      nodes: getGraphNodes(),
      edges: getGraphEdges(),
      aiSettings: state.settings?.ai
    });
    if (result?.ok && result.content) {
      graphChat.setGreeting(result.content);
    }
  } catch (error) {
    // 问候语只是锦上添花，失败不该影响图谱本身
  }
}

function getAcceptedEvidence() {
  const turns = collectQaTurns({
    highlights: state.highlights,
    threads: state.threads,
    messagesByThread: state.messagesByThread,
    summaries: state.summaries,
    blocks: state.blocks
  });
  return collectAcceptedEvidence({ turns, nodes: state.nodes });
}

function renderEvidenceList() {
  elements.evidenceList.replaceChildren();
  const evidence = getAcceptedEvidence();
  if (!evidence.length) {
    const empty = document.createElement("p");
    empty.className = "evidence-empty";
    empty.textContent =
      "还没有加入知识图谱的问答。回到阅读器，在想收录的那一轮下面点「＋ 加入知识图谱」，它就会出现在这里，然后拖到画布上。";
    elements.evidenceList.append(empty);
    return;
  }

  evidence.forEach((turn, index) => {
    const item = document.createElement("div");
    item.className = "evidence-item";
    item.dataset.sourceKey = turn.sourceKey;
    if (turn.placed) {
      item.classList.add("placed");
    } else {
      item.draggable = true;
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(EVIDENCE_DRAG_TYPE, turn.sourceKey);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "copy";
        }
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
    }

    const title = document.createElement("span");
    title.className = "evidence-item-title";
    title.textContent = `#${index + 1} ${createNodeTitle(turn.question || turn.threadTitle)}`;

    const text = document.createElement("span");
    text.className = "evidence-item-text";
    text.textContent = createSnippet(turn.summary || turn.answer, 120);

    const meta = document.createElement("span");
    meta.className = "evidence-item-meta";
    meta.textContent = [
      turn.quote ? "锚在划线" : "针对全文",
      turn.chapterTitle,
      turn.placed ? "已在画布上" : "拖到画布上放置",
      formatDateTime(turn.answeredAt)
    ]
      .filter(Boolean)
      .join(" · ");

    const actions = document.createElement("div");
    actions.className = "evidence-item-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link-button evidence-item-delete";
    remove.dataset.sourceKey = turn.sourceKey;
    remove.textContent = "删除这轮对话";
    remove.title = "把这一轮问答从阅读记录里删掉";
    actions.append(remove);

    item.append(title, text, meta, actions);
    elements.evidenceList.append(item);
  });
}

async function handleEvidenceDrop(sourceKey, graphPoint) {
  const turn = getAcceptedEvidence().find((item) => item.sourceKey === sourceKey);
  if (!turn) {
    setStatus("这条证据已经不在列表里了，请重新读取记录。");
    return;
  }
  if (turn.placed) {
    setStatus("这条证据已经在画布上了。");
    return;
  }

  pushUndoSnapshot();
  const spot = findFreeSpot(getGraphNodes(), graphPoint || getViewportCenterPoint());
  const node = await placeQaTurnNode({
    documentId,
    turn,
    x: spot.x,
    y: spot.y,
    order: state.nodes.length
  });
  state.nodes = [...state.nodes, node];
  renderGraph();
  renderEvidenceList();
  await refreshSummaryFreshness();
  setStatus("已放置切片。从卡片右侧圆点拖到另一张卡片就能建立关联。");
}

/*
 * 删除一轮问答。不可逆，所以要点两次；第二次才真的删。
 * 只删这一轮的问题、回答和它们的摘要，画布上已放置的切片保留（会变成孤立），
 * 和「清空对话记录」的取舍一致。
 */
let armedEvidenceKey = "";
let armedEvidenceTimer = 0;

function disarmEvidenceDelete() {
  window.clearTimeout(armedEvidenceTimer);
  armedEvidenceTimer = 0;
  armedEvidenceKey = "";
  elements.evidenceList.querySelectorAll(".evidence-item-delete").forEach((button) => {
    button.classList.remove("armed");
    button.textContent = "删除这轮对话";
  });
}

async function handleEvidenceDelete(sourceKey, button) {
  if (armedEvidenceKey !== sourceKey) {
    disarmEvidenceDelete();
    armedEvidenceKey = sourceKey;
    button.classList.add("armed");
    button.textContent = "再点一次删除";
    armedEvidenceTimer = window.setTimeout(disarmEvidenceDelete, 5000);
    setStatus("再点一次会删掉这一轮问答；画布上已放置的切片会保留，变成孤立切片。");
    return;
  }

  const turn = getAcceptedEvidence().find((item) => item.sourceKey === sourceKey);
  disarmEvidenceDelete();
  if (!turn) {
    setStatus("这条记录已经不在了。");
    return;
  }

  const summary = await deleteQaTurnRecords({
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.sourceKey
  });
  await loadKnowledgeData({ preserveScroll: true });
  setStatus(`已删除这一轮问答（${summary.messages} 条消息、${summary.summaries} 条摘要）。`);
}

function handleEvidenceClick(event) {
  const deleteButton = event.target.closest?.(".evidence-item-delete");
  if (deleteButton?.dataset.sourceKey) {
    event.stopPropagation();
    void handleEvidenceDelete(deleteButton.dataset.sourceKey, deleteButton);
    return;
  }

  const item = event.target.closest?.(".evidence-item");
  const sourceKey = item?.dataset.sourceKey;
  if (!sourceKey) {
    return;
  }
  // 已放置的点一下定位到画布上那张卡；没放置的点击不做事，请拖到画布上
  const node = getGraphNodes().find((entry) => entry.sourceKey === sourceKey);
  if (!node) {
    setStatus("这条证据还没放到画布上，拖到右边画布即可。");
    return;
  }
  openNodeDetail(node.id);
  graphView.focusNode(node.id);
}

/* ----------------------------------------------------------------- graph edits */

function pushUndoSnapshot() {
  undoStack.push(snapshotGraph({ nodes: state.nodes, edges: state.edges }));
  updateUndoButton();
}

function updateUndoButton() {
  elements.undoButton.disabled = undoStack.size === 0;
}

async function handleUndo() {
  const snapshot = undoStack.pop();
  updateUndoButton();
  if (!snapshot) {
    return;
  }

  await restoreGraphSnapshot(documentId, snapshot);
  const graph = await loadGraph(documentId);
  state.nodes = graph.nodes;
  state.edges = graph.edges;
  state.selectedNodeId = "";
  closeNodeDetail();
  closeEdgePopover();
  renderGraph();
  renderEvidenceList();
  await refreshSummaryFreshness();
  setStatus("已撤销上一步图谱调整。");
}

async function handleNodeMoved(nodeId, x, y) {
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return;
  }
  pushUndoSnapshot();
  const moved = { ...node, x, y, pinned: true };
  Object.assign(node, moved);
  await saveNode(moved);
  renderGraph();
}

async function handleConnect(fromNodeId, toNodeId, clientPoint) {
  const duplicate = state.edges.find(
    (edge) => !edge.removed && edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId
  );
  if (duplicate) {
    openEdgePopover(duplicate.id, clientPoint);
    return;
  }

  pushUndoSnapshot();
  const edge = await createUserEdge({ documentId, fromNodeId, toNodeId, relation: "" });
  state.edges = [...state.edges, edge];
  renderGraph();
  openEdgePopover(edge.id, clientPoint);
  await refreshSummaryFreshness();
  setStatus("已新建关联，填写关联说明可以让摘要更准确。");
}

async function handleCanvasDoubleClick(graphPoint) {
  pushUndoSnapshot();
  const spot = findFreeSpot(getGraphNodes(), graphPoint || getViewportCenterPoint());
  const node = await createNoteNode({ documentId, x: spot.x, y: spot.y });
  state.nodes = [...state.nodes, node];
  renderGraph();
  renderEvidenceList();
  openNodeDetail(node.id);
  elements.nodeDetailTitleInput.focus();
  elements.nodeDetailTitleInput.select();
  await refreshSummaryFreshness();
  setStatus("已新建手动切片，填写内容后记得保存。");
}

function getViewportCenterPoint() {
  const nodes = getGraphNodes();
  if (!nodes.length) {
    return { x: 0, y: 0 };
  }
  const last = nodes[nodes.length - 1];
  return { x: (last.x ?? 0) + NODE_SIZE.width + 60, y: last.y ?? 0 };
}

async function handleRelayout() {
  pushUndoSnapshot();
  const nodes = getGraphNodes();
  for (const node of nodes) {
    node.pinned = false;
  }
  seedMissingPositions(nodes);
  runLayout(nodes, getGraphEdges(), resolveLayoutOptions(state.settings));
  await saveNodePositions(nodes);
  renderGraph();
  graphView.fit();
  setStatus("已按关联关系重新排布；再拖动任意卡片可以重新固定它。");
}

async function handleTimelineLayout() {
  pushUndoSnapshot();
  const nodes = getGraphNodes();
  runTimelineLayout(nodes);
  for (const node of nodes) {
    node.pinned = true;
  }
  await saveNodePositions(nodes);
  renderGraph();
  graphView.fit();
  setStatus("已按提问顺序整理成时间线，同一条划线的追问排在同一行右侧。");
}

/*
 * 图谱问答的回答加进图谱时，只放一张新切片，不替读者连线。
 * 以前会自动连到聚焦切片或最后一张上并标成「图谱追问」——那是系统替读者
 * 断言了一层关系。关联由读者自己拉，和手动放置切片的规则保持一致。
 */
async function handleAddChatAnswerToGraph({ question, answer, model }) {
  pushUndoSnapshot();
  const spot = findFreeSpot(getGraphNodes(), getViewportCenterPoint());
  const node = await createGraphQaNode({ documentId, question, answer, model, x: spot.x, y: spot.y });
  state.nodes = [...state.nodes, node];

  renderGraph();
  renderEvidenceList();
  await refreshSummaryFreshness();
  return node;
}

/* ------------------------------------------------------------- node detail */

function openNodeDetail(nodeId) {
  const node = getGraphNodes().find((item) => item.id === nodeId);
  if (!node) {
    return;
  }

  state.selectedNodeId = nodeId;
  state.selectedEdgeId = "";
  closeEdgePopover();
  renderGraph();

  elements.nodeDetail.hidden = false;
  elements.nodeDetailTitle.textContent = node.title || "未命名切片";
  elements.nodeDetailMeta.textContent = [
    node.kind === "qa" ? `第 ${(node.order ?? 0) + 1} 次提问` : node.kind === "note" ? "手动切片" : "图谱提问",
    node.chapterTitle,
    formatDateTime(node.createdAt),
    node.orphan ? "原始阅读记录已删除" : ""
  ]
    .filter(Boolean)
    .join(" · ");

  toggleSection(elements.nodeDetailQuoteSection, Boolean(node.quote), () => {
    elements.nodeDetailQuote.textContent = node.quote;
  });
  toggleSection(elements.nodeDetailQuestionSection, Boolean(node.question), () => {
    renderMessageContent(elements.nodeDetailQuestion, node.question);
  });
  toggleSection(elements.nodeDetailAnswerSection, Boolean(node.answer), () => {
    renderMessageContent(elements.nodeDetailAnswer, node.answer);
  });

  const editable = node.kind !== "qa" || node.orphan;
  elements.nodeDetailEditSection.hidden = !editable;
  elements.nodeDetailTitleInput.value = node.title || "";
  elements.nodeDetailBodyInput.value = node.body || "";
  elements.nodeDetailLocate.hidden = !node.highlightId;
  elements.nodeDetailConvert.hidden = !(node.kind === "qa" && node.orphan);
}

function toggleSection(section, visible, render) {
  section.hidden = !visible;
  if (visible) {
    render();
  }
}

function closeNodeDetail() {
  elements.nodeDetail.hidden = true;
}

function clearSelection() {
  state.selectedNodeId = "";
  state.selectedEdgeId = "";
  closeNodeDetail();
  closeEdgePopover();
  renderGraph();
}

async function handleSaveNodeEdits() {
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node) {
    return;
  }

  pushUndoSnapshot();
  const updated = {
    ...node,
    title: elements.nodeDetailTitleInput.value.trim() || "未命名切片",
    body: elements.nodeDetailBodyInput.value,
    titleEdited: true
  };
  Object.assign(node, await saveNode(updated));
  renderGraph();
  renderEvidenceList();
  openNodeDetail(node.id);
  await refreshSummaryFreshness();
  setStatus("切片已保存。");
}

async function handleConvertToNote() {
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  if (!(node?.kind === "qa" && node.orphan)) {
    return;
  }

  pushUndoSnapshot();
  const converted = await convertNodeToNote({
    ...node,
    title: elements.nodeDetailTitleInput.value.trim() || node.title || "未命名切片",
    body: elements.nodeDetailBodyInput.value
  });
  state.nodes = state.nodes.map((item) => (item.id === node.id ? converted : item));
  renderGraph();
  renderEvidenceList();
  openNodeDetail(converted.id);
  await refreshSummaryFreshness();
  setStatus("已转为手动切片：与已删除的阅读记录脱钩，手动建立的连线保持不变。");
}

async function handleDeleteNode() {
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node) {
    return;
  }

  pushUndoSnapshot();
  const result = await deleteNodeCascade({ node, edges: state.edges });
  const removedEdgeIds = new Set(result.removedEdgeIds);
  state.edges = state.edges.filter((edge) => !removedEdgeIds.has(edge.id));
  state.nodes = result.node
    ? state.nodes.map((item) => (item.id === node.id ? result.node : item))
    : state.nodes.filter((item) => item.id !== node.id);

  state.selectedNodeId = "";
  closeNodeDetail();
  renderGraph();
  renderEvidenceList();
  graphChat.pruneFocusNodes(getGraphNodes().map((item) => item.id));
  await refreshSummaryFreshness();
  setStatus(
    node.kind === "qa"
      ? "已从图谱中移除这个切片，阅读器里的划线和问答记录仍然保留。"
      : "已删除这个手动切片。"
  );
}

async function handleLocateInReader() {
  const node = state.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node?.highlightId) {
    return;
  }
  await openOrFocusExtensionPage(
    `src/reader/reader.html?documentId=${encodeURIComponent(documentId)}&highlightId=${encodeURIComponent(node.highlightId)}`
  );
}

/* ------------------------------------------------------------- edge popover */

function openEdgePopover(edgeId, clientPoint) {
  const edge = state.edges.find((item) => item.id === edgeId);
  if (!edge) {
    return;
  }

  state.selectedEdgeId = edgeId;
  renderGraph();

  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  elements.edgePopoverMeta.textContent = [
    `${nodesById.get(edge.fromNodeId)?.title || "切片"} → ${nodesById.get(edge.toNodeId)?.title || "切片"}`,
    edge.origin === "user" ? "你手动建立的关联" : edge.confirmed ? "你已确认的自动关联" : "按提问顺序自动生成，尚未确认"
  ].join(" · ");
  elements.edgeRelationInput.value = edge.relation || "";
  elements.edgeConfirmButton.textContent = edge.origin === "user" || edge.confirmed ? "保存" : "保存并确认";

  elements.edgePopover.hidden = false;
  const point = clientPoint || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const rect = elements.edgePopover.getBoundingClientRect();
  elements.edgePopover.style.left = `${Math.min(point.x, window.innerWidth - rect.width - 16)}px`;
  elements.edgePopover.style.top = `${Math.min(point.y, window.innerHeight - rect.height - 16)}px`;
  elements.edgeRelationInput.focus();
}

function closeEdgePopover() {
  elements.edgePopover.hidden = true;
  if (state.selectedEdgeId) {
    state.selectedEdgeId = "";
    renderGraph();
  }
}

async function handleSaveEdge() {
  const edge = state.edges.find((item) => item.id === state.selectedEdgeId);
  if (!edge) {
    return;
  }

  pushUndoSnapshot();
  const updated = await saveEdge({
    ...edge,
    relation: elements.edgeRelationInput.value.trim(),
    confirmed: true
  });
  state.edges = state.edges.map((item) => (item.id === updated.id ? updated : item));
  closeEdgePopover();
  renderGraph();
  await refreshSummaryFreshness();
  setStatus("关联已保存，摘要重新生成时会优先采信它。");
}

async function handleReverseEdge() {
  const edge = state.edges.find((item) => item.id === state.selectedEdgeId);
  if (!edge) {
    return;
  }

  pushUndoSnapshot();
  const updated = await saveEdge({
    ...edge,
    fromNodeId: edge.toNodeId,
    toNodeId: edge.fromNodeId,
    relation: elements.edgeRelationInput.value.trim(),
    confirmed: true
  });
  state.edges = state.edges.map((item) => (item.id === updated.id ? updated : item));
  renderGraph();
  openEdgePopover(updated.id, null);
  await refreshSummaryFreshness();
}

async function handleDeleteEdge() {
  const edge = state.edges.find((item) => item.id === state.selectedEdgeId);
  if (!edge) {
    return;
  }

  pushUndoSnapshot();
  const result = await removeEdge(edge);
  state.edges = result.deleted
    ? state.edges.filter((item) => item.id !== edge.id)
    : state.edges.map((item) => (item.id === edge.id ? result.edge : item));
  closeEdgePopover();
  renderGraph();
  await refreshSummaryFreshness();
  setStatus(result.deleted ? "关联已删除。" : "已删除这条自动关联，同步阅读记录时不会再生成它。");
}

/* ------------------------------------------------------------------ summary */

async function renderCachedReportState() {
  const report = state.documentRecord?.knowledgeReport;
  if (!report?.content) {
    elements.reportOutput.textContent = "暂无摘要。整理好切片后点击“重新生成摘要”。";
    elements.summaryMeta.textContent = "摘要是这张图谱的文字版总览。";
    setStatus("已读取阅读记录，尚未生成摘要。");
    setSummaryStale(false);
    return;
  }

  if (!elements.userPrompt.value && report.userPrompt) {
    elements.userPrompt.value = report.userPrompt;
  }
  renderReportMarkdown(report.content);
  elements.summaryMeta.textContent = `摘要生成时间：${formatDateTime(report.generatedAt)}`;

  const fresh = await refreshSummaryFreshness();
  setStatus(fresh ? "当前图谱与摘要一致。" : "图谱内容已变化，可在顶部重新生成摘要。");
}

function renderReportMarkdown(markdown) {
  elements.reportOutput.classList.remove("report-output-streaming");
  const blocks = markdownToBlocks(markdown, documentId);
  renderBlocks(elements.reportOutput, blocks);
}

/** Returns true when the cached summary still matches the current graph. */
async function refreshSummaryFreshness() {
  const report = state.documentRecord?.knowledgeReport;
  if (!report?.content) {
    setSummaryStale(false);
    return true;
  }

  const signature = await createCurrentSignature();
  const fresh = report.signature === signature;
  setSummaryStale(!fresh);
  return fresh;
}

function setSummaryStale(isStale) {
  elements.summaryStaleBanner.hidden = !isStale;
  elements.summaryPanel.classList.toggle("is-stale", isStale);
}

async function handleGenerateReport() {
  if (!state.documentRecord) {
    setStatus("还没有可生成摘要的阅读记录。");
    return;
  }

  const signature = await createCurrentSignature();
  const cachedReport = state.documentRecord.knowledgeReport;
  if (cachedReport?.signature === signature && cachedReport?.content) {
    renderReportMarkdown(cachedReport.content);
    setSummaryStale(false);
    setStatus(`图谱没有变化，已显示缓存摘要，生成时间：${formatDateTime(cachedReport.generatedAt)}。`);
    return;
  }

  setSummaryCollapsed(false);
  setBusy(true);
  startKnowledgeGenerationTimer();
  resetKnowledgeStreamPreview();
  try {
    const result = await generateKnowledgeReport({
      documentRecord: state.documentRecord,
      blocks: state.blocks,
      highlights: state.highlights,
      threads: state.threads,
      messagesByThread: state.messagesByThread,
      summaries: state.summaries,
      userPrompt: elements.userPrompt.value,
      graph: createGraphSignaturePayload({ nodes: getGraphNodes(), edges: getGraphEdges() }),
      timeoutMs: KNOWLEDGE_GENERATION_TIMEOUT_MS,
      onDelta: appendKnowledgeReportDelta
    });

    if (!result.ok) {
      const elapsedSeconds = stopKnowledgeGenerationTimer();
      restoreKnowledgeReportAfterFailedStream(cachedReport);
      if (result.cancelled) {
        setStatus(`摘要生成已取消，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。未覆盖上次缓存结果。`);
        return;
      }
      const reason = result.error || "模型请求没有成功";
      setStatus(`摘要生成失败，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。${reason}。未覆盖上次缓存结果。`);
      return;
    }

    const savedAt = nowIso();
    const nextDocument = {
      ...state.documentRecord,
      knowledgeReport: {
        signature,
        userPrompt: elements.userPrompt.value,
        content: result.content,
        ai: {
          runId: result.runId || "",
          model: result.model || "",
          demo: Boolean(result.demo)
        },
        generatedAt: savedAt
      }
    };
    await dbPut("documents", nextDocument);
    state.documentRecord = nextDocument;
    renderReportMarkdown(result.content);
    elements.summaryMeta.textContent = `摘要生成时间：${formatDateTime(savedAt)}`;
    setSummaryStale(false);
    const elapsedSeconds = stopKnowledgeGenerationTimer();
    setStatus(`摘要已生成，时间：${formatDateTime(savedAt)}，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。`);
  } catch (error) {
    const elapsedSeconds = stopKnowledgeGenerationTimer();
    restoreKnowledgeReportAfterFailedStream(cachedReport);
    const reason = error instanceof Error ? error.message : String(error);
    setStatus(`摘要生成失败，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。${reason}。未覆盖上次缓存结果。`);
  } finally {
    stopKnowledgeGenerationTimer();
    setBusy(false);
  }
}

async function createCurrentSignature() {
  const settings = await getLatestSettings();
  return createKnowledgeReportSignature({
    documentRecord: state.documentRecord,
    highlights: state.highlights,
    threads: state.threads,
    messagesByThread: state.messagesByThread,
    summaries: state.summaries,
    userPrompt: elements.userPrompt.value,
    graph: createGraphSignaturePayload({ nodes: getGraphNodes(), edges: getGraphEdges() }),
    settings
  });
}

async function getLatestSettings() {
  try {
    state.settings = await getSettings();
  } catch {
    // Keep the last loaded settings if storage is temporarily unavailable.
  }
  return state.settings || {};
}

/* ------------------------------------------------------------------- layout UI */

function restoreUiState() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    applyUiState();
    return;
  }

  storage.get(KNOWLEDGE_UI_KEY).then((result) => {
    const ui = result?.[KNOWLEDGE_UI_KEY] || {};
    state.summaryCollapsed = Boolean(ui.summaryCollapsed);
    state.chatCollapsed = Boolean(ui.chatCollapsed);
    state.evidenceCollapsed = ui.evidenceCollapsed !== false;
    applyUiState();
  });
}

function persistUiState() {
  const storage = globalThis.chrome?.storage?.local;
  const result = storage?.set({
    [KNOWLEDGE_UI_KEY]: {
      summaryCollapsed: state.summaryCollapsed,
      chatCollapsed: state.chatCollapsed,
      evidenceCollapsed: state.evidenceCollapsed
    }
  });
  result?.catch?.(() => {});
}

function applyUiState() {
  elements.summaryPanel.dataset.collapsed = String(state.summaryCollapsed);
  if (elements.summaryBody.open === state.summaryCollapsed) {
    elements.summaryBody.open = !state.summaryCollapsed;
  }
  elements.chatPanel.dataset.collapsed = String(state.chatCollapsed);
  elements.chatCollapseButton.setAttribute("aria-expanded", String(!state.chatCollapsed));
  elements.chatCollapseButton.title = state.chatCollapsed ? "展开问答窗口" : "收起问答窗口";
  elements.evidenceDrawer.dataset.collapsed = String(state.evidenceCollapsed);
  elements.evidenceToggle.setAttribute("aria-expanded", String(!state.evidenceCollapsed));
}

function setSummaryCollapsed(collapsed) {
  state.summaryCollapsed = collapsed;
  applyUiState();
  persistUiState();
}

function setChatCollapsed(collapsed) {
  state.chatCollapsed = collapsed;
  applyUiState();
  persistUiState();
}

function setEvidenceCollapsed(collapsed) {
  state.evidenceCollapsed = collapsed;
  applyUiState();
  persistUiState();
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    closeEdgePopover();
    closeNodeDetail();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTypingTarget(event.target)) {
    event.preventDefault();
    void handleUndo();
  }
}

function isTypingTarget(target) {
  const tagName = target?.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || target?.isContentEditable;
}

/* ------------------------------------------------------- generation progress */

function resetKnowledgeStreamPreview() {
  generationProgress.streamContent = "";
  generationProgress.streamRenderedContent = "";
  generationProgress.streamRenderQueued = false;
  elements.reportOutput.classList.add("report-output-streaming");
  elements.reportOutput.textContent = "正在等待模型开始输出摘要...";
}

function appendKnowledgeReportDelta(delta) {
  const chunk = String(delta || "");
  if (!chunk) {
    return;
  }
  generationProgress.streamContent = `${generationProgress.streamContent || ""}${chunk}`;
  queueKnowledgeStreamPreviewRender();
}

function queueKnowledgeStreamPreviewRender() {
  if (generationProgress.streamRenderQueued) {
    return;
  }
  generationProgress.streamRenderQueued = true;
  requestAnimationFrame(() => {
    generationProgress.streamRenderQueued = false;
    renderKnowledgeStreamPreview();
  });
}

function renderKnowledgeStreamPreview() {
  const content = String(generationProgress.streamContent || "");
  if (content === generationProgress.streamRenderedContent) {
    return;
  }
  generationProgress.streamRenderedContent = content;
  elements.reportOutput.textContent = content || "正在等待模型开始输出摘要...";
}

function restoreKnowledgeReportAfterFailedStream(cachedReport) {
  generationProgress.streamContent = "";
  generationProgress.streamRenderedContent = "";
  generationProgress.streamRenderQueued = false;
  elements.reportOutput.classList.remove("report-output-streaming");
  if (cachedReport?.content) {
    renderReportMarkdown(cachedReport.content);
    return;
  }
  elements.reportOutput.textContent = "暂无可用的摘要。生成中断后已丢弃临时流式内容，请再次生成。";
}

function setBusy(isBusy, message = "") {
  const locked = isBusy || isKnowledgeGenerating() || !documentId;
  elements.regenerateButton.disabled = locked;
  elements.staleRegenerateButton.disabled = locked;
  elements.reloadButton.disabled = locked;
  if (message) {
    setStatus(message);
  }
}

function setStatus(message) {
  elements.status.textContent = message;
}

function isKnowledgeGenerating() {
  return Boolean(generationProgress.timerId || generationProgress.startedAtMs);
}

function startKnowledgeGenerationTimer() {
  stopKnowledgeGenerationTimer();
  generationProgress.startedAtMs = Date.now();
  updateKnowledgeGenerationStatus();
  generationProgress.timerId = globalThis.setInterval(updateKnowledgeGenerationStatus, 1000);
}

function stopKnowledgeGenerationTimer() {
  const elapsedSeconds = getKnowledgeGenerationElapsedSeconds();
  if (generationProgress.timerId) {
    globalThis.clearInterval(generationProgress.timerId);
    generationProgress.timerId = 0;
  }
  generationProgress.startedAtMs = 0;
  return elapsedSeconds;
}

function updateKnowledgeGenerationStatus() {
  const elapsedSeconds = getKnowledgeGenerationElapsedSeconds();
  const startedAt = formatRunStartTime(generationProgress.startedAtMs);
  const stage = getKnowledgeGenerationStage(elapsedSeconds);
  setStatus(`正在生成摘要。开始时间：${startedAt}；已用：${formatElapsedSeconds(elapsedSeconds)}；阶段：${stage}。`);
}

function getKnowledgeGenerationElapsedSeconds() {
  if (!generationProgress.startedAtMs) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - generationProgress.startedAtMs) / 1000));
}

function getKnowledgeGenerationStage(elapsedSeconds) {
  return KNOWLEDGE_GENERATION_STAGES.reduce((current, stage) => {
    return elapsedSeconds >= stage.minElapsedSeconds ? stage.label : current;
  }, KNOWLEDGE_GENERATION_STAGES[0].label);
}

/* ------------------------------------------------------------------- helpers */

function getMessageCount() {
  return Object.values(state.messagesByThread).reduce((total, messages) => total + messages.length, 0);
}

function sortSummaries(summaries) {
  return [...summaries].sort(
    (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
  );
}

function createSnippet(text, limit = 120) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "没有文本。";
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatElapsedSeconds(seconds) {
  return `${Math.max(0, Number(seconds) || 0)} 秒`;
}

function formatRunStartTime(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatDateTime(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
