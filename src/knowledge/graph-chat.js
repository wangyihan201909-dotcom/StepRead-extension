import { createId, nowIso } from "../shared/defaults.js";
import { dbDelete, dbGetAllByIndex, dbPut } from "../shared/db.js";
import { askGraphChat } from "../shared/ai-client.js";
import { renderMessageContent } from "../shared/rich-text.js";

const CHAT_TIMEOUT_MS = 180_000;

/**
 * The per-graph chat window. It talks about the graph as a whole, so its history
 * lives in its own store instead of the reading threads, and answers only become
 * slices when the reader explicitly asks for it.
 */
export function createGraphChat({ elements, documentId, callbacks = {} }) {
  const state = {
    messages: [],
    focusNodeIds: [],
    activeRun: null,
    streamContent: "",
    greeting: ""
  };

  elements.chatForm.addEventListener("submit", handleSubmit);
  elements.chatInput.addEventListener("keydown", handleComposerKeydown);
  elements.chatStopButton.addEventListener("click", stopActiveRun);
  elements.chatClearButton.addEventListener("click", handleClear);
  elements.chatMessages.addEventListener("click", handleMessagesClick);
  elements.chatFocusList.addEventListener("click", handleFocusClick);

  async function load() {
    const messages = await dbGetAllByIndex("graphChatMessages", "by_documentId", documentId);
    state.messages = sortMessages(messages);
    render();
  }

  function render() {
    renderFocusList();
    renderMessages();
  }

  function renderFocusList() {
    const nodes = callbacks.getGraphContext?.()?.nodes || [];
    const focusNodes = state.focusNodeIds
      .map((nodeId) => nodes.find((node) => node.id === nodeId))
      .filter(Boolean);

    elements.chatFocusList.replaceChildren();
    elements.chatFocusList.hidden = !focusNodes.length;
    if (!focusNodes.length) {
      return;
    }

    const label = document.createElement("span");
    label.className = "chat-focus-label";
    label.textContent = "只问这些切片：";
    elements.chatFocusList.append(label);

    for (const node of focusNodes) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-focus-chip";
      chip.dataset.nodeId = node.id;
      chip.title = "移除";
      chip.textContent = node.title || "未命名切片";
      elements.chatFocusList.append(chip);
    }
  }

  function renderMessages() {
    elements.chatMessages.replaceChildren();
    // 开场问候语代替了原来页面顶部那段摘要，每次打开重新生成，不落库
    if (state.greeting) {
      const greeting = document.createElement("article");
      greeting.className = "chat-message chat-message-assistant chat-greeting";
      const content = document.createElement("div");
      content.className = "message-content";
      renderMessageContent(content, state.greeting);
      greeting.append(content);
      elements.chatMessages.append(greeting);
    }

    if (!state.messages.length && !state.activeRun) {
      const empty = document.createElement("p");
      empty.className = "chat-empty";
      empty.textContent = "就这张图谱提问，例如：我已经问清楚了哪些概念？还有哪些没问透？";
      elements.chatMessages.append(empty);
      return;
    }

    for (const message of state.messages) {
      elements.chatMessages.append(createMessageCard(message));
    }

    if (state.activeRun) {
      elements.chatMessages.append(createStreamCard());
    }

    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  function createMessageCard(message) {
    const article = document.createElement("article");
    article.className = `chat-message chat-message-${message.role}`;
    article.dataset.messageId = message.id;

    const content = document.createElement("div");
    content.className = "message-content";
    renderMessageContent(content, message.content);
    article.append(content);

    if (message.role === "assistant") {
      const actions = document.createElement("div");
      actions.className = "chat-message-actions";

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "link-button";
      addButton.dataset.action = "add-to-graph";
      addButton.disabled = Boolean(message.addedNodeId);
      addButton.textContent = message.addedNodeId ? "已加入图谱" : "加入图谱";
      actions.append(addButton);

      if (message.model) {
        const model = document.createElement("span");
        model.className = "chat-message-model";
        model.textContent = message.model;
        actions.append(model);
      }

      article.append(actions);
    }

    return article;
  }

  function createStreamCard() {
    const article = document.createElement("article");
    article.className = "chat-message chat-message-assistant is-streaming";
    const content = document.createElement("div");
    content.className = "message-content";
    renderMessageContent(content, state.streamContent || "正在等待模型回答...");
    article.append(content);
    return article;
  }

  function handleComposerKeydown(event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      elements.chatForm.requestSubmit();
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const question = elements.chatInput.value.trim();
    if (!question || state.activeRun) {
      return;
    }

    const context = callbacks.getGraphContext?.() || {};
    if (!context.nodes?.length) {
      setStatus("这张图谱还没有切片，先划线提问或手动新建一个切片。");
      return;
    }

    const userMessage = {
      id: createId("gchat"),
      documentId,
      role: "user",
      content: question,
      focusNodeIds: [...state.focusNodeIds],
      model: "",
      addedNodeId: "",
      createdAt: nowIso()
    };
    await dbPut("graphChatMessages", userMessage);
    state.messages.push(userMessage);
    elements.chatInput.value = "";

    const controller = new AbortController();
    state.activeRun = { controller, cancelled: false };
    state.streamContent = "";
    setBusy(true, "正在基于这张图谱回答...");
    renderMessages();

    try {
      const result = await askGraphChat({
        documentRecord: context.documentRecord,
        report: context.report,
        nodes: context.nodes,
        edges: context.edges,
        focusNodeIds: [...state.focusNodeIds],
        history: state.messages.slice(0, -1),
        question,
        scope: context.settings?.knowledgeGraph?.chatContextScope,
        aiSettings: context.settings?.ai,
        signal: controller.signal,
        timeoutMs: CHAT_TIMEOUT_MS,
        onDelta: appendStreamDelta
      });

      if (!result.ok) {
        setStatus(
          result.cancelled
            ? "已停止本次回答，问题保留在记录里。"
            : `回答失败：${result.error || "模型请求没有成功"}。`
        );
        return;
      }

      const assistantMessage = {
        id: createId("gchat"),
        documentId,
        role: "assistant",
        content: result.content,
        focusNodeIds: [...state.focusNodeIds],
        model: result.model || "",
        addedNodeId: "",
        createdAt: nowIso()
      };
      await dbPut("graphChatMessages", assistantMessage);
      state.messages.push(assistantMessage);
      setStatus(result.demo ? "演示模式回答，配置 API Key 后会调用真实模型。" : "");
    } catch (error) {
      setStatus(`回答失败：${error instanceof Error ? error.message : String(error)}。`);
    } finally {
      state.activeRun = null;
      state.streamContent = "";
      setBusy(false);
      renderMessages();
    }
  }

  function appendStreamDelta(delta) {
    const chunk = String(delta || "");
    if (!chunk) {
      return;
    }
    state.streamContent += chunk;
    const streamCard = elements.chatMessages.querySelector(".chat-message.is-streaming .message-content");
    if (streamCard) {
      renderMessageContent(streamCard, state.streamContent);
      elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
      return;
    }
    renderMessages();
  }

  function stopActiveRun() {
    if (!state.activeRun) {
      return;
    }
    state.activeRun.cancelled = true;
    state.activeRun.controller.abort();
  }

  async function handleClear() {
    if (!state.messages.length) {
      return;
    }
    const removed = state.messages;
    state.messages = [];
    renderMessages();
    await Promise.all(removed.map((message) => dbDelete("graphChatMessages", message.id)));
    setStatus("已清空这张图谱的问答记录。");
  }

  async function handleMessagesClick(event) {
    const button = event.target.closest?.("[data-action='add-to-graph']");
    if (!button) {
      return;
    }

    const messageId = button.closest(".chat-message")?.dataset.messageId;
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return;
    }

    const assistantMessage = state.messages[index];
    const question = findPrecedingQuestion(index);
    const node = await callbacks.onAddToGraph?.({
      question,
      answer: assistantMessage.content,
      model: assistantMessage.model,
      focusNodeIds: assistantMessage.focusNodeIds || []
    });
    if (!node) {
      return;
    }

    const updated = { ...assistantMessage, addedNodeId: node.id };
    state.messages[index] = updated;
    await dbPut("graphChatMessages", updated);
    renderMessages();
    setStatus("已把这条回答加入图谱。");
  }

  function findPrecedingQuestion(assistantIndex) {
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (state.messages[index].role === "user") {
        return state.messages[index].content;
      }
    }
    return "";
  }

  function handleFocusClick(event) {
    const chip = event.target.closest?.(".chat-focus-chip");
    if (!chip) {
      return;
    }
    removeFocusNode(chip.dataset.nodeId);
  }

  function addFocusNode(nodeId) {
    if (!nodeId || state.focusNodeIds.includes(nodeId)) {
      return;
    }
    state.focusNodeIds.push(nodeId);
    renderFocusList();
    callbacks.onFocusChange?.([...state.focusNodeIds]);
    elements.chatInput.focus();
  }

  function removeFocusNode(nodeId) {
    state.focusNodeIds = state.focusNodeIds.filter((id) => id !== nodeId);
    renderFocusList();
    callbacks.onFocusChange?.([...state.focusNodeIds]);
  }

  function pruneFocusNodes(existingNodeIds) {
    const allowed = new Set(existingNodeIds);
    const next = state.focusNodeIds.filter((nodeId) => allowed.has(nodeId));
    if (next.length !== state.focusNodeIds.length) {
      state.focusNodeIds = next;
      renderFocusList();
      callbacks.onFocusChange?.([...state.focusNodeIds]);
    }
  }

  function setBusy(isBusy, message = "") {
    elements.chatSendButton.disabled = isBusy;
    elements.chatStopButton.hidden = !isBusy;
    elements.chatInput.readOnly = isBusy;
    if (message) {
      setStatus(message);
    }
  }

  function setStatus(message) {
    elements.chatStatus.textContent = message;
  }

  function setGreeting(text) {
    const next = String(text || "").replace(/\s+/g, " ").trim();
    // 硬性截到 50 字：模型偶尔会超，界面上不能因此被撑开
    state.greeting = next.length > 50 ? `${next.slice(0, 50)}…` : next;
    renderMessages();
  }

  return {
    load,
    render,
    renderFocusList,
    addFocusNode,
    pruneFocusNodes,
    setGreeting,
    getFocusNodeIds: () => [...state.focusNodeIds]
  };
}

function sortMessages(messages) {
  return [...messages].sort(
    (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
  );
}
