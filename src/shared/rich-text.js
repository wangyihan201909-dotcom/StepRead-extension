export function renderMessageContent(container, content) {
  container.replaceChildren();
  const text = String(content || "").replace(/\r\n/g, "\n");
  const codeBlockPattern = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = codeBlockPattern.exec(text))) {
    appendRichText(container, text.slice(cursor, match.index));
    appendCodeBlock(container, match[2], match[1]);
    cursor = match.index + match[0].length;
  }

  appendRichText(container, text.slice(cursor));
}

export function appendRichText(container, text) {
  if (!text) {
    return;
  }

  const blockMathPattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  let cursor = 0;
  let match;

  while ((match = blockMathPattern.exec(text))) {
    appendParagraphs(container, text.slice(cursor, match.index));
    appendMathBlock(container, stripMathDelimiters(match[0]));
    cursor = match.index + match[0].length;
  }

  appendParagraphs(container, text.slice(cursor));
}

export function appendParagraphs(container, text) {
  const paragraphs = String(text || "").split(/\n{2,}/);
  for (const paragraphText of paragraphs) {
    if (!paragraphText.trim()) {
      continue;
    }
    const paragraph = document.createElement("p");
    paragraph.className = "message-paragraph";
    appendInlineContent(paragraph, paragraphText);
    container.append(paragraph);
  }
}

export function appendInlineContent(parent, text) {
  const inlinePattern = /(`[^`]+`|\\\([^]*?\\\)|\$[^$\n]+\$)/g;
  let cursor = 0;
  let match;

  while ((match = inlinePattern.exec(text))) {
    appendPlainInline(parent, text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "message-inline-code";
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (!isLikelyInlineMathToken(token)) {
      appendPlainInline(parent, token);
    } else {
      const math = document.createElement("span");
      math.className = "math-inline";
      math.textContent = stripMathDelimiters(token);
      parent.append(math);
    }
    cursor = match.index + token.length;
  }

  appendPlainInline(parent, text.slice(cursor));
}

export function appendPlainInline(parent, text) {
  const lines = String(text || "").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      parent.append(document.createElement("br"));
    }
    if (line) {
      parent.append(document.createTextNode(line));
    }
  });
}

export function appendCodeBlock(container, codeText, language) {
  const pre = document.createElement("pre");
  pre.className = "message-code-block";
  const code = document.createElement("code");
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = codeText.trim();
  pre.append(code);
  container.append(pre);
}

export function appendMathBlock(container, mathText) {
  const block = document.createElement("div");
  block.className = "math-block";
  block.textContent = mathText.trim();
  container.append(block);
}

export function stripMathDelimiters(token) {
  if (token.startsWith("$$") && token.endsWith("$$")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("\\[") && token.endsWith("\\]")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("\\(") && token.endsWith("\\)")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("$") && token.endsWith("$")) {
    return token.slice(1, -1);
  }
  return token;
}

export function isLikelyInlineMathToken(token) {
  if (token.startsWith("\\(") && token.endsWith("\\)")) {
    return true;
  }

  if (!token.startsWith("$") || !token.endsWith("$")) {
    return false;
  }

  const formula = stripMathDelimiters(token).trim();
  return /\\[a-zA-Z]+|[\^_=+\-*/<>]|[∑∫√∞≈≠≤≥±×÷]|^[a-zA-Z][a-zA-Z0-9']*$/.test(formula);
}
