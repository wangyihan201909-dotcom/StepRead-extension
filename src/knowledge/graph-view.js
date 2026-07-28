import { NODE_SIZE, fitToView, hasPosition } from "./graph-layout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_SCALE = 0.2;
const MAX_SCALE = 2;
const DRAG_THRESHOLD_PX = 4;

const KIND_LABELS = {
  qa: "划线提问",
  note: "手动切片",
  "graph-qa": "图谱提问"
};

/**
 * Renders the graph as an SVG edge layer under an HTML card layer. Cards stay in
 * HTML so they can hold rich text, buttons and selectable content; both layers
 * share the same pan/zoom transform so they stay aligned.
 */
export function createGraphView({ container, callbacks = {} }) {
  const viewport = document.createElement("div");
  viewport.className = "graph-viewport";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "graph-edges");
  svg.append(createArrowDefs());

  const edgeLayer = document.createElementNS(SVG_NS, "g");
  edgeLayer.setAttribute("class", "graph-edge-layer");
  svg.append(edgeLayer);

  const nodeLayer = document.createElement("div");
  nodeLayer.className = "graph-node-layer";

  viewport.append(svg, nodeLayer);
  container.replaceChildren(viewport);

  const view = { x: 0, y: 0, scale: 1 };
  const state = {
    nodes: [],
    edges: [],
    selectedNodeId: "",
    selectedEdgeId: "",
    focusNodeIds: new Set(),
    cardBody: "summary",
    cardBodyLimit: 160
  };
  const nodeElements = new Map();
  let interaction = null;

  viewport.addEventListener("pointerdown", handlePointerDown);
  viewport.addEventListener("wheel", handleWheel, { passive: false });
  viewport.addEventListener("dblclick", handleDoubleClick);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);

  function render(next = {}) {
    state.nodes = next.nodes ?? state.nodes;
    state.edges = next.edges ?? state.edges;
    state.selectedNodeId = next.selectedNodeId ?? state.selectedNodeId;
    state.selectedEdgeId = next.selectedEdgeId ?? state.selectedEdgeId;
    state.focusNodeIds = new Set(next.focusNodeIds ?? [...state.focusNodeIds]);
    state.cardBody = next.cardBody ?? state.cardBody;
    state.cardBodyLimit = next.cardBodyLimit ?? state.cardBodyLimit;

    renderNodes();
    renderEdges();
    applyTransform();
  }

  function renderNodes() {
    const seen = new Set();
    for (const node of state.nodes) {
      if (!hasPosition(node)) {
        continue;
      }
      seen.add(node.id);
      let element = nodeElements.get(node.id);
      if (!element) {
        element = createNodeElement(node);
        nodeElements.set(node.id, element);
        nodeLayer.append(element);
      }
      updateNodeElement(element, node);
    }

    for (const [nodeId, element] of nodeElements) {
      if (!seen.has(nodeId)) {
        element.remove();
        nodeElements.delete(nodeId);
      }
    }
  }

  function createNodeElement(node) {
    const article = document.createElement("article");
    article.className = "graph-node";
    article.dataset.nodeId = node.id;

    const header = document.createElement("header");
    header.className = "graph-node-header";
    const index = document.createElement("span");
    index.className = "graph-node-index";
    const kind = document.createElement("span");
    kind.className = "graph-node-kind";
    header.append(index, kind);

    const title = document.createElement("h3");
    title.className = "graph-node-title";

    const quote = document.createElement("blockquote");
    quote.className = "graph-node-quote";

    const body = document.createElement("p");
    body.className = "graph-node-body";

    const meta = document.createElement("footer");
    meta.className = "graph-node-meta";

    const port = document.createElement("button");
    port.type = "button";
    port.className = "graph-node-port";
    port.dataset.port = "out";
    port.title = "拖到另一个切片上建立关联";
    port.setAttribute("aria-label", "拖出关联线");

    article.append(header, title, quote, body, meta, port);
    return article;
  }

  function updateNodeElement(element, node) {
    element.style.transform = `translate(${node.x}px, ${node.y}px)`;
    element.dataset.kind = node.kind;
    element.classList.toggle("is-selected", node.id === state.selectedNodeId);
    element.classList.toggle("is-focused", state.focusNodeIds.has(node.id));
    element.classList.toggle("is-orphan", Boolean(node.orphan));
    element.classList.toggle("is-pinned", Boolean(node.pinned));

    const index = element.querySelector(".graph-node-index");
    index.textContent = node.kind === "qa" ? `#${(node.order ?? 0) + 1}` : "＋";

    const kind = element.querySelector(".graph-node-kind");
    kind.textContent = node.orphan ? "原始记录已删除" : KIND_LABELS[node.kind] || "切片";

    element.querySelector(".graph-node-title").textContent = node.title || "未命名切片";

    const quote = element.querySelector(".graph-node-quote");
    quote.textContent = node.quote ? clip(node.quote, 90) : "";
    quote.hidden = !node.quote;

    const body = element.querySelector(".graph-node-body");
    const bodyText = getCardBodyText(node, state.cardBody, state.cardBodyLimit);
    body.textContent = bodyText;
    body.hidden = !bodyText;

    const meta = element.querySelector(".graph-node-meta");
    meta.textContent = [node.chapterTitle, formatShortTime(node.createdAt)].filter(Boolean).join(" · ");
    meta.hidden = !meta.textContent;
  }

  function renderEdges() {
    edgeLayer.replaceChildren();
    const nodesById = new Map(state.nodes.map((node) => [node.id, node]));

    for (const edge of state.edges) {
      const from = nodesById.get(edge.fromNodeId);
      const to = nodesById.get(edge.toNodeId);
      if (!hasPosition(from) || !hasPosition(to)) {
        continue;
      }

      const start = getCenter(from);
      const end = getCenter(to);
      const startPoint = clipToCard(start, end, from);
      const endPoint = clipToCard(end, start, to);
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("class", createEdgeClassName(edge));
      group.dataset.edgeId = edge.id;

      const hit = document.createElementNS(SVG_NS, "line");
      hit.setAttribute("class", "graph-edge-hit");
      setLine(hit, startPoint, endPoint);

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "graph-edge-line");
      line.setAttribute("marker-end", `url(#${getMarkerId(edge)})`);
      setLine(line, startPoint, endPoint);

      group.append(hit, line);

      if (edge.relation) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("class", "graph-edge-label");
        label.setAttribute("x", String((startPoint.x + endPoint.x) / 2));
        label.setAttribute("y", String((startPoint.y + endPoint.y) / 2 - 6));
        label.setAttribute("text-anchor", "middle");
        label.textContent = edge.relation;
        group.append(label);
      }

      edgeLayer.append(group);
    }

    if (interaction?.type === "connect") {
      edgeLayer.append(createDraftEdge(interaction));
    }
  }

  function createEdgeClassName(edge) {
    return [
      "graph-edge",
      `graph-edge-${edge.origin}`,
      edge.confirmed || edge.origin === "user" ? "is-strong" : "is-tentative",
      edge.id === state.selectedEdgeId ? "is-selected" : ""
    ]
      .filter(Boolean)
      .join(" ");
  }

  function createDraftEdge({ from, pointer }) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "graph-edge-draft");
    setLine(line, getCenter(from), pointer);
    return line;
  }

  function applyTransform() {
    const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    nodeLayer.style.transform = transform;
    edgeLayer.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  }

  function handlePointerDown(event) {
    if (event.button !== 0) {
      return;
    }

    const port = event.target.closest?.(".graph-node-port");
    if (port) {
      const node = getNodeFromElement(port.closest(".graph-node"));
      if (node) {
        event.preventDefault();
        interaction = { type: "connect", from: node, pointer: toGraphPoint(event) };
        viewport.classList.add("is-connecting");
        renderEdges();
      }
      return;
    }

    const nodeElement = event.target.closest?.(".graph-node");
    if (nodeElement) {
      const node = getNodeFromElement(nodeElement);
      if (!node) {
        return;
      }
      const pointer = toGraphPoint(event);
      interaction = {
        type: "node",
        node,
        moved: false,
        originX: node.x,
        originY: node.y,
        offsetX: pointer.x - node.x,
        offsetY: pointer.y - node.y,
        startClientX: event.clientX,
        startClientY: event.clientY
      };
      return;
    }

    const edgeGroup = event.target.closest?.(".graph-edge");
    if (edgeGroup) {
      callbacks.onSelectEdge?.(edgeGroup.dataset.edgeId, { x: event.clientX, y: event.clientY });
      return;
    }

    interaction = {
      type: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false
    };
    viewport.classList.add("is-panning");
  }

  function handlePointerMove(event) {
    if (!interaction) {
      return;
    }

    if (interaction.type === "pan") {
      const dx = event.clientX - interaction.startClientX;
      const dy = event.clientY - interaction.startClientY;
      if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
        interaction.moved = true;
      }
      view.x = interaction.originX + dx;
      view.y = interaction.originY + dy;
      applyTransform();
      return;
    }

    if (interaction.type === "node") {
      const dx = event.clientX - interaction.startClientX;
      const dy = event.clientY - interaction.startClientY;
      if (!interaction.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      interaction.moved = true;
      const pointer = toGraphPoint(event);
      interaction.node.x = pointer.x - interaction.offsetX;
      interaction.node.y = pointer.y - interaction.offsetY;
      const element = nodeElements.get(interaction.node.id);
      if (element) {
        element.style.transform = `translate(${interaction.node.x}px, ${interaction.node.y}px)`;
        element.classList.add("is-dragging");
      }
      renderEdges();
      return;
    }

    if (interaction.type === "connect") {
      interaction.pointer = toGraphPoint(event);
      const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".graph-node");
      for (const [nodeId, element] of nodeElements) {
        element.classList.toggle("is-connect-target", hovered?.dataset.nodeId === nodeId && nodeId !== interaction.from.id);
      }
      renderEdges();
    }
  }

  function handlePointerUp(event) {
    if (!interaction) {
      return;
    }
    const current = interaction;
    interaction = null;
    viewport.classList.remove("is-panning", "is-connecting");

    if (current.type === "node") {
      const element = nodeElements.get(current.node.id);
      element?.classList.remove("is-dragging");
      if (current.moved) {
        callbacks.onNodeMoved?.(current.node.id, current.node.x, current.node.y);
      } else {
        callbacks.onSelectNode?.(current.node.id);
      }
      return;
    }

    if (current.type === "connect") {
      for (const element of nodeElements.values()) {
        element.classList.remove("is-connect-target");
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".graph-node");
      const targetId = target?.dataset.nodeId;
      if (targetId && targetId !== current.from.id) {
        callbacks.onConnect?.(current.from.id, targetId, { x: event.clientX, y: event.clientY });
      }
      renderEdges();
      return;
    }

    if (current.type === "pan" && !current.moved) {
      callbacks.onCanvasClick?.();
    }
  }

  function handleWheel(event) {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const ratio = nextScale / view.scale;

    view.x = pointerX - (pointerX - view.x) * ratio;
    view.y = pointerY - (pointerY - view.y) * ratio;
    view.scale = nextScale;
    applyTransform();
  }

  function handleDoubleClick(event) {
    if (event.target.closest?.(".graph-node") || event.target.closest?.(".graph-edge")) {
      return;
    }
    callbacks.onCanvasDoubleClick?.(toGraphPoint(event));
  }

  function toGraphPoint(event) {
    const rect = viewport.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.scale,
      y: (event.clientY - rect.top - view.y) / view.scale
    };
  }

  function getNodeFromElement(element) {
    return state.nodes.find((node) => node.id === element?.dataset.nodeId) || null;
  }

  function fit() {
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const next = fitToView(state.nodes, { width: rect.width, height: rect.height });
    view.x = next.x;
    view.y = next.y;
    view.scale = next.scale;
    applyTransform();
  }

  function focusNode(nodeId) {
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!hasPosition(node)) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    view.x = rect.width / 2 - (node.x + NODE_SIZE.width / 2) * view.scale;
    view.y = rect.height / 2 - (node.y + NODE_SIZE.height / 2) * view.scale;
    applyTransform();
  }

  function zoomBy(factor) {
    const rect = viewport.getBoundingClientRect();
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const ratio = nextScale / view.scale;
    view.x = rect.width / 2 - (rect.width / 2 - view.x) * ratio;
    view.y = rect.height / 2 - (rect.height / 2 - view.y) * ratio;
    view.scale = nextScale;
    applyTransform();
  }

  function destroy() {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    container.replaceChildren();
  }

  return { render, fit, focusNode, zoomBy, destroy, getViewport: () => viewport };
}

function createArrowDefs() {
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const [id, className] of [
    ["graph-arrow-strong", "graph-arrow-strong"],
    ["graph-arrow-tentative", "graph-arrow-tentative"]
  ]) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
    path.setAttribute("class", className);
    marker.append(path);
    defs.append(marker);
  }
  return defs;
}

function getMarkerId(edge) {
  return edge.confirmed || edge.origin === "user" ? "graph-arrow-strong" : "graph-arrow-tentative";
}

function setLine(element, start, end) {
  element.setAttribute("x1", String(start.x));
  element.setAttribute("y1", String(start.y));
  element.setAttribute("x2", String(end.x));
  element.setAttribute("y2", String(end.y));
}

function getCenter(node) {
  return { x: node.x + NODE_SIZE.width / 2, y: node.y + NODE_SIZE.height / 2 };
}

/** Moves a connection endpoint from the card centre onto the card border. */
function clipToCard(center, towards, node) {
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  if (!dx && !dy) {
    return center;
  }

  const halfWidth = NODE_SIZE.width / 2 + 6;
  const halfHeight = NODE_SIZE.height / 2 + 6;
  const scale = Math.min(
    dx ? halfWidth / Math.abs(dx) : Infinity,
    dy ? halfHeight / Math.abs(dy) : Infinity
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function getCardBodyText(node, cardBody, limit) {
  if (node.kind === "note") {
    return clip(node.body, limit);
  }
  if (cardBody === "answer") {
    return clip(node.answer, limit);
  }
  if (cardBody === "quote") {
    return clip(node.quote || node.answer, limit);
  }
  return clip(node.summary || node.answer, limit);
}

function clip(value, limit) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatShortTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(
    date
  );
}
