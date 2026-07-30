/**
 * A small force-directed layout written by hand.
 *
 * The extension CSP only allows `script-src 'self'`, so no graph library can be
 * loaded, and the repository has no build step or dependencies. Graphs here stay
 * well under a few hundred nodes, so the naive O(n^2) repulsion is fast enough
 * and a quadtree would only add code to maintain.
 */

export const DEFAULT_LAYOUT_OPTIONS = {
  repulsion: 26000,
  linkDistance: 240,
  centerGravity: 0.035,
  damping: 0.82,
  iterations: 320,
  minSeparation: 200
};

export const NODE_SIZE = {
  width: 260,
  height: 148
};

export function resolveLayoutOptions(settings = {}) {
  const layout = settings?.knowledgeGraph?.layout || {};
  return {
    ...DEFAULT_LAYOUT_OPTIONS,
    repulsion: toNumber(layout.repulsion, DEFAULT_LAYOUT_OPTIONS.repulsion),
    linkDistance: toNumber(layout.linkDistance, DEFAULT_LAYOUT_OPTIONS.linkDistance),
    centerGravity: toNumber(layout.centerGravity, DEFAULT_LAYOUT_OPTIONS.centerGravity)
  };
}

/**
 * Seeds coordinates for nodes that never had any, laid out on a spiral around
 * the existing cloud so a fresh graph does not start fully overlapped.
 */
export function seedMissingPositions(nodes) {
  const placed = nodes.filter(hasPosition);
  const center = getCenter(placed);
  const seeded = [];

  let spiralIndex = 0;
  for (const node of nodes) {
    if (hasPosition(node)) {
      continue;
    }
    const angle = spiralIndex * 2.399963229728653; // golden angle keeps seeds spread out
    const radius = 160 + 46 * Math.sqrt(spiralIndex + 1);
    node.x = center.x + Math.cos(angle) * radius;
    node.y = center.y + Math.sin(angle) * radius;
    spiralIndex += 1;
    seeded.push(node.id);
  }

  return seeded;
}

/**
 * Relaxes the graph in place.
 *
 * `mobileIds` restricts which nodes may move. Pinned nodes never move, so a user
 * who arranged part of the canvas keeps that arrangement while new slices settle.
 */
export function runLayout(nodes, edges, options = {}) {
  const settings = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const mobileIds = options.mobileIds ? new Set(options.mobileIds) : null;
  const positioned = nodes.filter(hasPosition);
  if (positioned.length < 2) {
    return nodes;
  }

  const nodesById = new Map(positioned.map((node) => [node.id, node]));
  const links = edges
    .filter((edge) => nodesById.has(edge.fromNodeId) && nodesById.has(edge.toNodeId))
    .map((edge) => ({ source: nodesById.get(edge.fromNodeId), target: nodesById.get(edge.toNodeId) }));
  const velocities = new Map(positioned.map((node) => [node.id, { vx: 0, vy: 0 }]));
  const center = getCenter(positioned);

  const canMove = (node) => !node.pinned && (!mobileIds || mobileIds.has(node.id));

  for (let step = 0; step < settings.iterations; step += 1) {
    for (let i = 0; i < positioned.length; i += 1) {
      for (let j = i + 1; j < positioned.length; j += 1) {
        const a = positioned[i];
        const b = positioned[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1) {
          dx = (Math.random() - 0.5) * 4;
          dy = (Math.random() - 0.5) * 4;
          distanceSquared = dx * dx + dy * dy || 1;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = settings.repulsion / distanceSquared;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        applyForce(velocities, a, -fx, -fy);
        applyForce(velocities, b, fx, fy);
      }
    }

    for (const link of links) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - settings.linkDistance) * 0.06;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      applyForce(velocities, link.source, fx, fy);
      applyForce(velocities, link.target, -fx, -fy);
    }

    for (const node of positioned) {
      applyForce(
        velocities,
        node,
        (center.x - node.x) * settings.centerGravity,
        (center.y - node.y) * settings.centerGravity
      );
    }

    for (const node of positioned) {
      const velocity = velocities.get(node.id);
      if (!canMove(node)) {
        velocity.vx = 0;
        velocity.vy = 0;
        continue;
      }
      velocity.vx *= settings.damping;
      velocity.vy *= settings.damping;
      node.x += clamp(velocity.vx, -60, 60);
      node.y += clamp(velocity.vy, -60, 60);
    }
  }

  separateOverlaps(positioned, settings.minSeparation, canMove);
  return nodes;
}

/**
 * Arranges nodes as a single chronological column with follow-up questions
 * branching to the right, used by the "整理成时间线" toolbar action.
 */
export function runTimelineLayout(nodes) {
  const ordered = [...nodes].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
  );
  const columnByThread = new Map();
  let row = 0;

  for (const node of ordered) {
    const threadKey = node.threadId || node.id;
    if (!columnByThread.has(threadKey)) {
      columnByThread.set(threadKey, 0);
    } else {
      columnByThread.set(threadKey, columnByThread.get(threadKey) + 1);
    }
    node.x = columnByThread.get(threadKey) * (NODE_SIZE.width + 90);
    node.y = row * (NODE_SIZE.height + 70);
    row += 1;
  }

  return nodes;
}

export function getGraphBounds(nodes) {
  const positioned = nodes.filter(hasPosition);
  if (!positioned.length) {
    return { minX: 0, minY: 0, maxX: NODE_SIZE.width, maxY: NODE_SIZE.height };
  }

  return positioned.reduce(
    (bounds, node) => ({
      minX: Math.min(bounds.minX, node.x),
      minY: Math.min(bounds.minY, node.y),
      maxX: Math.max(bounds.maxX, node.x + NODE_SIZE.width),
      maxY: Math.max(bounds.maxY, node.y + NODE_SIZE.height)
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
}

export function fitToView(nodes, viewport, options = {}) {
  const padding = options.padding ?? 72;
  const bounds = getGraphBounds(nodes);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = clamp(
    Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height),
    options.minScale ?? 0.25,
    options.maxScale ?? 1.2
  );

  return {
    scale,
    x: viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
    y: viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale
  };
}

export function findFreeSpot(nodes, preferred) {
  const step = 40;
  let candidate = { ...preferred };

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const collides = nodes.some(
      (node) =>
        hasPosition(node) &&
        Math.abs(node.x - candidate.x) < NODE_SIZE.width * 0.9 &&
        Math.abs(node.y - candidate.y) < NODE_SIZE.height * 0.9
    );
    if (!collides) {
      return candidate;
    }
    candidate = { x: candidate.x + step, y: candidate.y + step };
  }

  return candidate;
}

export function hasPosition(node) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.y);
}

function separateOverlaps(nodes, minSeparation, canMove) {
  for (let pass = 0; pass < 12; pass += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = NODE_SIZE.width + 32 - Math.abs(dx);
        const overlapY = NODE_SIZE.height + 28 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        moved = true;
        const pushX = (overlapX / 2) * (dx >= 0 ? 1 : -1);
        const pushY = (overlapY / 2) * (dy >= 0 ? 1 : -1);
        if (overlapX < overlapY) {
          if (canMove(a)) a.x -= pushX;
          if (canMove(b)) b.x += pushX;
        } else {
          if (canMove(a)) a.y -= pushY;
          if (canMove(b)) b.y += pushY;
        }
      }
    }
    if (!moved) {
      return;
    }
  }
}

function applyForce(velocities, node, fx, fy) {
  const velocity = velocities.get(node.id);
  if (!velocity) {
    return;
  }
  velocity.vx += fx;
  velocity.vy += fy;
}

function getCenter(nodes) {
  if (!nodes.length) {
    return { x: 0, y: 0 };
  }
  const total = nodes.reduce((sum, node) => ({ x: sum.x + node.x, y: sum.y + node.y }), { x: 0, y: 0 });
  return { x: total.x / nodes.length, y: total.y / nodes.length };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
