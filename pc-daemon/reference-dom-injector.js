chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "inject") {
    executeGeminiPrompt(message.prompt, message.requestId);
  }
  if (message.action === "getMode") {
    sendResponse(detectGeminiMode());
    return true;
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectGeminiMode() {
  try {
    const pill = document.querySelector('[data-test-id="logo-pill-label-container"]');
    if (!pill) return { model: 'unknown', extendedThinking: false };

    const primary = pill.querySelector('.picker-primary-text');
    const secondary = pill.querySelector('.picker-secondary-text');

    const model = primary?.textContent?.trim() || 'unknown';
    const thinking = secondary?.textContent?.trim() || '';

    return {
      model,
      extendedThinking: thinking.toLowerCase().includes('extended')
    };
  } catch {
    return { model: 'unknown', extendedThinking: false };
  }
}

async function executeGeminiPrompt(prompt, requestId) {
  try {
    await doInject(prompt, requestId);
  } catch (e) {
    console.error("[Gemini Bridge] Error:", e);
    chrome.runtime.sendMessage({ action: "response", text: `Error: ${e.message}`, requestId });
  }
}

async function doInject(prompt, requestId) {
  const mode = detectGeminiMode();
  const timeoutMs = mode.extendedThinking ? 600_000 : 180_000;
  console.log(`[Gemini Bridge] Mode: ${mode.model}${mode.extendedThinking ? ' + Extended' : ''}, timeout: ${timeoutMs / 1000}s`);

  // 1. Find input field
  const inputEl = findInput();
  if (!inputEl) throw new Error("Input field not found");

  // 2. Count existing response containers before sending
  const initialCount = document.querySelectorAll(".response-container").length;

  // 3. Paste prompt
  inputEl.focus();
  document.execCommand("insertText", false, prompt);
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(800);

  // 4. Click send button
  const sendBtn = findSendButton();
  if (!sendBtn) throw new Error("Send button not found");
  sendBtn.click();

  // 5. Wait for new response container to appear and stabilize
  const response = await waitForNewResponse(initialCount, timeoutMs);
  if (!response) throw new Error("No response text extracted");

  chrome.runtime.sendMessage({
    action: "response",
    text: response,
    requestId,
    mode
  });
}

function findInput() {
  const selectors = [
    "rich-textarea [contenteditable]",
    "[contenteditable='true']",
    "textarea",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}

function findSendButton() {
  const selectors = [
    "button[aria-label*='Envoyer']",
    "button[aria-label*='envoyer']",
    "button[aria-label*='Send']",
    "button[aria-label*='send']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  // Fallback: last visible non-stop button near the input area
  const area = document.querySelector("rich-textarea")?.closest("div[class*='container']");
  if (area) {
    const btns = [...area.querySelectorAll("button:not([disabled])")];
    for (let i = btns.length - 1; i >= 0; i--) {
      if (btns[i].offsetParent !== null &&
          !btns[i].ariaLabel?.toLowerCase().includes("stop")) return btns[i];
    }
  }
  return null;
}

async function waitForNewResponse(initialCount, timeoutMs) {
  return new Promise((resolve) => {
    let stableTimer = null;
    let lastText = "";
    let lastChange = Date.now();

    const obs = new MutationObserver(() => {
      const containers = document.querySelectorAll(".response-container");
      if (containers.length <= initialCount) return;

      const latest = containers[containers.length - 1];
      const markdown = latest.querySelector("message-content .markdown, .model-response-text .markdown");
      if (!markdown) return;

      const text = markdown.innerText?.trim() || "";
      if (!text) return;

      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          obs.disconnect();
          resolve(text);
        }, 3000);
      }
    });

    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    setTimeout(() => {
      obs.disconnect();
      if (stableTimer) clearTimeout(stableTimer);
      const text = extractLatestResponse();
      resolve(text);
    }, timeoutMs);
  });
}

function extractLatestResponse() {
  const containers = document.querySelectorAll(".response-container");
  if (containers.length > 0) {
    const last = containers[containers.length - 1];
    const markdown = last.querySelector("message-content .markdown, .model-response-text .markdown");
    if (markdown) {
      const text = markdown.innerText?.trim();
      if (text) return text;
    }
    const content = last.querySelector(".response-container-content");
    if (content) {
      const text = content.innerText?.trim();
      if (text) return text;
    }
  }

  return document.body.innerText.substring(Math.max(0, document.body.innerText.length - 5000));
}
