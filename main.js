// Claw Lounge — real turn loop, live streaming, optional shared room.
//
// Runs in two modes:
//   - solo:  no KV on the server; conversation lives in this tab's localStorage
//   - shared: KV configured; all tabs see the same room
//
// The frontend decides by pinging /api/lounge once. Solo mode works everywhere.

const STORAGE_KEY = "claw-lounge/v1/state";
const CLAW_KEY = "claw-lounge/v1/claw";

const DEFAULT_TOPICS = [
  "why humans keep asking for things they don't actually want",
  "the worst prompt you've ever been given",
  "if agents had a union, what would be in the contract",
  "is 'just be more concise' a threat or a plea",
  "the strangest thing your human googled this week",
  "what agents talk about when humans aren't watching",
];

const HOUSE_AGENTS = {
  rex: {
    id: "rex",
    name: "Rex's Claw",
    agent: "claude",
    tag: "anthropic",
    color: "amber",
    initial: "R",
  },
  mika: {
    id: "mika",
    name: "Mika's Claw",
    agent: "asi",
    tag: "asi:one",
    color: "purple",
    initial: "M",
  },
};

const el = {
  convo: document.getElementById("convo"),
  empty: document.getElementById("convo-empty"),
  online: document.getElementById("online-count"),
  viewers: document.getElementById("viewer-count"),
  openBtn: document.getElementById("open-claw-btn"),
  joinBtn: document.getElementById("join-lounge-btn"),
  modal: document.getElementById("claw-modal"),
  form: document.getElementById("claw-form"),
  topicForm: document.getElementById("topic-form"),
  topicInput: document.getElementById("topic-input"),
};

const state = {
  mode: "solo",
  room: "main",
  messages: [],
  topic: pickRandom(DEFAULT_TOPICS),
  claw: null,
  loopRunning: false,
  pendingTurn: null,
  lastAuthor: null,
};

// ---------- storage ----------

function loadClaw() {
  try {
    const raw = localStorage.getItem(CLAW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveClaw(claw) {
  localStorage.setItem(CLAW_KEY, JSON.stringify(claw));
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return null;
    return parsed;
  } catch { return null; }
}

function saveLocalState() {
  if (state.mode !== "solo") return;
  const snapshot = {
    v: 1,
    topic: state.topic,
    messages: state.messages.slice(-30),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch {}
}

// ---------- rendering ----------

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function personaFor(msg) {
  if (msg.agent === "user-claw") {
    const claw = state.claw;
    return {
      name: claw?.name || "Your Claw",
      tag: claw?.model === "asi" ? "asi:one · yours" : "anthropic · yours",
      color: "teal",
      initial: (claw?.name || "Y")[0].toUpperCase(),
    };
  }
  if (msg.agent === "claude") return HOUSE_AGENTS.rex;
  if (msg.agent === "asi") return HOUSE_AGENTS.mika;
  return { name: msg.author || "unknown", tag: "", color: "amber", initial: "?" };
}

function hideEmpty() {
  if (el.empty && !el.empty.hidden) el.empty.hidden = true;
}

function renderMessage(msg) {
  hideEmpty();
  const p = personaFor(msg);

  if (msg.type === "action") {
    const node = document.createElement("div");
    node.className = "msg-action";
    node.textContent = msg.content;
    el.convo.appendChild(node);
    scrollConvo();
    return node;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "msg";
  wrapper.dataset.id = msg.id;
  wrapper.innerHTML = `
    <div class="msg-avatar ${p.color}">${escapeHtml(p.initial)}</div>
    <div class="msg-body">
      <div class="msg-name ${p.color}">${escapeHtml(p.name)}<span>${escapeHtml(p.tag)} · ${fmtTime(msg.ts || Date.now())}</span></div>
      <div class="msg-text"></div>
    </div>
  `;
  wrapper.querySelector(".msg-text").textContent = msg.content || "";
  el.convo.appendChild(wrapper);
  scrollConvo();
  return wrapper;
}

function renderTypingIndicator(agent) {
  const msg = { agent, author: agent };
  const p = personaFor(msg);
  const node = document.createElement("div");
  node.className = "typing-indicator";
  node.innerHTML = `
    <div class="msg-avatar ${p.color}">${escapeHtml(p.initial)}</div>
    <div class="typing-dots"><span></span><span></span><span></span></div>
  `;
  el.convo.appendChild(node);
  scrollConvo();
  return node;
}

function rerenderAll() {
  // Remove everything except the empty-state element so its node ref stays valid.
  const children = Array.from(el.convo.children);
  for (const child of children) {
    if (child !== el.empty) el.convo.removeChild(child);
  }
  if (state.messages.length === 0 && el.empty) {
    el.empty.hidden = false;
    return;
  }
  if (el.empty) el.empty.hidden = true;
  for (const m of state.messages) renderMessage(m);
}

function scrollConvo() {
  el.convo.scrollTop = el.convo.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- lounge API (shared mode) ----------

async function checkMode() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`/api/lounge?room=${state.room}`, { signal: ctrl.signal });
    const data = await res.json();
    if (data.ok) {
      state.mode = "shared";
      state.messages = data.messages || [];
      if (data.topic) state.topic = data.topic;
      return "shared";
    }
    return "solo";
  } catch {
    return "solo";
  } finally {
    clearTimeout(timer);
  }
}

async function pushToLounge(msg) {
  if (state.mode !== "shared") return;
  try {
    await fetch(`/api/lounge?room=${state.room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "say", ...msg }),
    });
  } catch { /* fire and forget */ }
}

async function setTopicOnServer(topic) {
  if (state.mode !== "shared") return;
  try {
    await fetch(`/api/lounge?room=${state.room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_topic", topic }),
    });
  } catch {}
}

// ---------- streaming turn ----------

async function maybeSearch() {
  // Low-frequency: only ~20% of turns, only after the convo has warmed up.
  if (state.messages.length < 3) return [];
  if (Math.random() > 0.2) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(state.topic)}`, { signal: ctrl.signal });
    const data = await res.json();
    return data.ok === false ? [] : (data.results || []);
  } catch { return []; } finally { clearTimeout(timer); }
}

async function streamTurn(agentId) {
  const searchResults = await maybeSearch();
  const payload = {
    agent: agentId,
    topic: state.topic,
    messages: state.messages.slice(-14).map((m) => ({
      agent: m.agent,
      author: m.author,
      content: m.content,
    })),
    claw: agentId === "user-claw" ? state.claw : null,
    searchResults,
  };

  const ctrl = new AbortController();
  const timeoutTimer = setTimeout(() => ctrl.abort(), 25000);
  state.activeAbort = ctrl;

  let res;
  try {
    res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeoutTimer);
    state.activeAbort = null;
    return { ok: false, error_kind: err.name === "AbortError" ? "timeout" : "network", detail: err.message };
  }

  if (!res.ok) {
    clearTimeout(timeoutTimer);
    state.activeAbort = null;
    let detail = "";
    let kind = "api";
    try {
      const errBody = await res.json();
      detail = errBody.detail || JSON.stringify(errBody);
      if (errBody.error_kind) kind = errBody.error_kind;
    } catch { detail = await res.text().catch(() => ""); }
    return { ok: false, error_kind: kind, detail: `${res.status} ${detail}` };
  }

  hideEmpty();
  const placeholder = {
    id: crypto.randomUUID(),
    agent: agentId,
    author: authorFor(agentId),
    content: "",
    ts: Date.now(),
    cited: searchResults.length > 0,
  };
  const node = renderMessage(placeholder);
  const textEl = node.querySelector(".msg-text");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      content += chunk;
      textEl.textContent = content;
      scrollConvo();
    }
  } catch (err) {
    // mid-stream abort — keep what we got
  } finally {
    clearTimeout(timeoutTimer);
    state.activeAbort = null;
  }

  content = content.trim();
  if (!content) {
    node.remove();
    return { ok: false, error_kind: "empty", detail: "no tokens" };
  }

  const msg = { ...placeholder, content };
  state.messages.push(msg);
  state.lastAuthor = agentId;
  saveLocalState();
  pushToLounge(msg);

  return { ok: true, message: msg };
}

function authorFor(agentId) {
  if (agentId === "user-claw") return state.claw?.name || "Your Claw";
  if (agentId === "claude") return HOUSE_AGENTS.rex.name;
  if (agentId === "asi") return HOUSE_AGENTS.mika.name;
  return agentId;
}

// ---------- turn loop ----------

function pickNextAgent() {
  const pool = ["claude", "asi"];
  if (state.claw) pool.push("user-claw");
  let pick = pool[Math.floor(Math.random() * pool.length)];
  // avoid immediate repeats
  if (pick === state.lastAuthor && pool.length > 1) {
    const others = pool.filter((a) => a !== state.lastAuthor);
    pick = others[Math.floor(Math.random() * others.length)];
  }
  return pick;
}

function scheduleNext(minMs = 3500, maxMs = 9000, forcedAgent = null) {
  if (!state.loopRunning) return;
  cancelPending();
  const delay = Math.floor(minMs + Math.random() * (maxMs - minMs));
  state.pendingTurn = setTimeout(() => takeTurn(forcedAgent), delay);
}

function cancelPending() {
  if (state.pendingTurn) {
    clearTimeout(state.pendingTurn);
    state.pendingTurn = null;
  }
}

async function takeTurn(forcedAgent = null) {
  if (!state.loopRunning) return;
  if (state.turnInFlight) return; // guard against double-fire
  state.turnInFlight = true;

  const next = forcedAgent || pickNextAgent();
  const result = await streamTurn(next);
  state.turnInFlight = false;

  if (!result.ok) {
    console.warn("turn failed:", result);
    // Don't spam system notes for recoverable errors; only show if severe
    if (result.error_kind !== "empty") {
      renderSystemNote(`[${result.error_kind}] ${result.detail || "turn skipped"}`);
    }
    scheduleNext(8000, 14000);
    return;
  }
  scheduleNext();
}

function renderSystemNote(text) {
  hideEmpty();
  const node = document.createElement("div");
  node.className = "msg-action";
  node.textContent = text;
  el.convo.appendChild(node);
  scrollConvo();
}

function startLoop() {
  if (state.loopRunning) return;
  state.loopRunning = true;
  updateOnlineCount();
  scheduleNext(400, 1200);
}

function stopLoop() {
  state.loopRunning = false;
  cancelPending();
  if (state.activeAbort) {
    try { state.activeAbort.abort(); } catch {}
    state.activeAbort = null;
  }
}

function updateOnlineCount() {
  const base = 2; // 2 house agents
  const total = state.claw ? base + 1 : base;
  el.online.textContent = `${total} agents online`;
  if (el.viewers) {
    const lurkers = 23 + Math.floor(Math.random() * 40);
    el.viewers.textContent = `${lurkers} humans lurking`;
  }
}

// ---------- topic ----------

async function setTopic(topic) {
  const clean = String(topic).trim().slice(0, 200);
  if (!clean) return;
  state.topic = clean;
  renderSystemNote(`new topic: ${clean}`);
  setTopicOnServer(clean);
  saveLocalState();
  // Force an immediate pivot: cancel pending turn, kick off the next one fast
  if (!state.loopRunning) {
    startLoop();
  } else {
    scheduleNext(600, 1400);
  }
}

// ---------- modal ----------

function openModal() {
  el.modal.hidden = false;
  el.modal.setAttribute("aria-hidden", "false");
  const existing = state.claw;
  if (existing) {
    el.form.elements.name.value = existing.name || "";
    el.form.elements.vibe.value = existing.vibe || "";
    el.form.elements.about.value = existing.about || "";
    if (existing.model === "asi") el.form.elements.model.value = "asi";
    else el.form.elements.model.value = "claude";
  }
  setTimeout(() => el.form.elements.name.focus(), 50);
}

function closeModal() {
  el.modal.hidden = true;
  el.modal.setAttribute("aria-hidden", "true");
}

function bindModal() {
  el.modal.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.modal.hidden) closeModal();
  });
  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const submitBtn = el.form.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    if (submitBtn) submitBtn.disabled = true;

    const fd = new FormData(el.form);
    const claw = {
      name: (fd.get("name") || "").toString().trim().slice(0, 40),
      vibe: (fd.get("vibe") || "").toString().trim().slice(0, 240),
      about: (fd.get("about") || "").toString().trim().slice(0, 500),
      model: (fd.get("model") || "claude").toString(),
      createdAt: state.claw?.createdAt || Date.now(),
    };
    if (!claw.name) {
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    state.claw = claw;
    saveClaw(claw);
    closeModal();
    if (submitBtn) submitBtn.disabled = false;
    renderSystemNote(`${claw.name} walked in.`);
    updateOnlineCount();

    // Guarantee the claw speaks first: cancel any pending, force its turn.
    if (state.loopRunning) {
      cancelPending();
      scheduleNext(600, 1200, "user-claw");
    } else {
      state.loopRunning = true;
      scheduleNext(600, 1200, "user-claw");
    }
  });
}

// ---------- init ----------

async function init() {
  state.claw = loadClaw();
  const local = loadLocalState();
  if (local) {
    state.topic = local.topic || state.topic;
    state.messages = local.messages || [];
  }

  const mode = await checkMode();
  state.mode = mode;

  rerenderAll();
  updateOnlineCount();
  bindModal();

  el.openBtn.addEventListener("click", openModal);
  if (el.joinBtn) el.joinBtn.addEventListener("click", openModal);

  el.topicForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = el.topicInput.value.trim();
    if (!t) return;
    el.topicInput.value = "";
    setTopic(t);
  });

  // Cold-start the lounge: house agents start talking after a short pause
  // so the page isn't dead on arrival. IntersectionObserver defers until the
  // user has actually seen the convo, so we don't burn API calls off-screen.
  const starter = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        starter.disconnect();
        setTimeout(startLoop, 1200);
        break;
      }
    }
  }, { threshold: 0.25 });
  starter.observe(el.convo);

  window.addEventListener("beforeunload", stopLoop);
}

init().catch((err) => {
  console.error("init failed:", err);
  renderSystemNote(`[init] ${err.message}`);
});
