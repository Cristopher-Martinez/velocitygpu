/**
 * PoC frontend. A single page: pick a model → rent → watch the deployment live
 * → chat (SSE streaming). Vanilla JS, no build step.
 */

const $ = (sel) => document.querySelector(sel);
const state = { models: [], selected: null, polling: null, messages: [], canAutoConfig: null, uptime: { timer: null, startedAt: null } };

// ── Environment: desktop (auto-config) or web (manual steps)? ───────────────

/** Asks the server which mode it runs in, to adapt the opencode panel. */
async function loadEnvironment() {
  try {
    const res = await fetch("/api/environment");
    if (!res.ok) return;
    const env = await res.json();
    state.canAutoConfig = Boolean(env.canAutoConfig);
    document.body.classList.toggle("mode-desktop", state.canAutoConfig);
    document.body.classList.toggle("mode-web", !state.canAutoConfig);
  } catch {
    /* no environment info: the panel falls back to web mode */
  }
}

// ── Step 1: model catalog ───────────────────────────────────────────────────

async function loadModels() {
  const res = await fetch("/api/models");
  const { models } = await res.json();
  state.models = models;
  const grid = $("#model-grid");
  grid.innerHTML = "";
  for (const m of models) {
    const card = document.createElement("div");
    card.className = "model-card";
    card.dataset.id = m.id;
    const gpuLabel = m.tensorParallel > 1 ? `${m.tensorParallel}× GPU (tensor-parallel)` : "1 GPU";
    card.innerHTML = `
      <h3>${m.label}</h3>
      <div class="meta">
        <span class="badge">${m.params}B params</span>
        <span class="badge gpu">${gpuLabel}</span>
        <span class="badge">≥ ${m.minTotalVramGb}GB VRAM</span>
        ${m.gated ? '<span class="badge gated">gated</span>' : ""}
      </div>
      <p class="blurb">${m.blurb}</p>`;
    card.addEventListener("click", () => selectModel(m.id));
    grid.appendChild(card);
  }
}

function selectModel(id) {
  state.selected = id;
  document.querySelectorAll(".model-card").forEach((c) =>
    c.classList.toggle("selected", c.dataset.id === id),
  );
  renderModelSpecs(state.models.find((m) => m.id === id));
  $("#rent-btn").disabled = false;
}

/** Formats a token count as "16,384 (16K)" for human reading. */
function fmtTokens(n) {
  if (typeof n !== "number") return "—";
  const withThousands = n.toLocaleString("en-US");
  const k = n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`;
  return `${withThousands} (${k})`;
}

/** Readable quantization label (GGUF Q4 / AWQ INT4 vs native FP16). */
function fmtQuant(q) {
  if (q === "gguf-q4") return "GGUF · Q4";
  if (q === "awq") return "AWQ · INT4";
  if (q === "gptq") return "GPTQ · INT4";
  return "FP16 · native";
}

/** Total VRAM in GB, or "—" if the datum is missing (partially reconciled instance). */
function fmtVram(gb) {
  return typeof gb === "number" && gb > 0 ? `${gb}GB` : "—";
}

/** Formatted price per hour, or "price n/a" if the datum is missing. Does NOT crash. */
function fmtDph(dph) {
  return Number.isFinite(dph) ? `$${dph.toFixed(3)}/h` : "price n/a";
}

/**
 * Renders the chosen model's spec sheet BEFORE renting: context window, max
 * output, hardware and cost. The user decides with the numbers in view instead
 * of burning money blindly.
 */
function renderModelSpecs(model) {
  const box = $("#model-specs");
  if (!model) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const gpus = model.tensorParallel > 1
    ? `${model.tensorParallel}× GPU · tensor-parallel`
    : "1 GPU";
  const price = typeof model.approxDph === "number"
    ? `~$${model.approxDph.toFixed(2)}/h`
    : "—";
  const rows = [
    ["🪟", "Context window", fmtTokens(model.contextLen), "input + output, shared"],
    ["✍️", "Max output", fmtTokens(model.outputLen), "cap per response"],
    ["🧮", "Parameters", `${model.params}B`, fmtQuant(model.quantization)],
    ["🖥️", "Hardware", gpus, `≥ ${model.minTotalVramGb}GB VRAM`],
    ["💾", "Disk", `${model.diskGb}GB`, "model weights"],
    ["💸", "Approx. cost", price, model.gated ? "gated model" : "open"],
  ];
  const items = rows
    .map(
      ([icon, label, value, hint]) => `
      <div class="spec-item">
        <span class="spec-icon">${icon}</span>
        <div class="spec-body">
          <span class="spec-label">${label}</span>
          <span class="spec-value">${value}</span>
          <span class="spec-hint">${hint}</span>
        </div>
      </div>`,
    )
    .join("");
  box.innerHTML = `
    <div class="specs-head">
      <strong>📋 Spec sheet · ${model.label}</strong>
      <code class="specs-repo">${model.repo}</code>
    </div>
    <div class="specs-grid">${items}</div>
    <p class="specs-note">
      The <b>context window</b> is the total the model "sees" (your prompt +
      history + reply). The <b>max output</b> is the capped share of it reserved
      for what the model generates. Ollama starts with
      <code>OLLAMA_CONTEXT_LENGTH=${model.contextLen}</code> and opencode
      receives the same limit when syncing.
    </p>`;
  box.classList.remove("hidden");
}

async function loadAccount() {
  try {
    const res = await fetch("/api/account");
    if (!res.ok) return;
    const { balance } = await res.json();
    if (typeof balance === "number") {
      $("#account").querySelector("span").textContent = `$${balance.toFixed(2)}`;
    }
  } catch {
    /* not showing the balance is not critical */
  }
}

// ── Step 2: rental + status polling ─────────────────────────────────────────

async function rent() {
  $("#rent-btn").disabled = true;
  $("#step-status").classList.remove("hidden");
  setPhase("searching", "Looking for a GPU machine for your model…");
  try {
    const res = await fetch("/api/rent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: state.selected }),
    });
    const data = await res.json();
    if (!res.ok) {
      setPhase("error", data.error ?? "Rental failed.");
      $("#rent-btn").disabled = false;
      return;
    }
    if (data.offer) showOffer(data.offer, data.model);
    startPolling();
  } catch (err) {
    setPhase("error", String(err));
    $("#rent-btn").disabled = false;
  }
}

function showOffer(offer, model) {
  const box = $("#offer-info");
  box.classList.add("show");
  box.innerHTML = `
    Rented: <b>${offer.numGpus ?? 1}× ${offer.gpuName ?? "GPU"}</b> ·
    <b>${fmtVram(offer.totalVramGb)}</b> total VRAM ·
    <b>${fmtDph(offer.dphTotal)}</b> ·
    ${model.tensorParallel > 1 ? `split across <b>${model.tensorParallel}</b> GPUs` : "1 GPU"}`;
}

function startPolling() {
  stopPolling();
  state.polling = setInterval(pollStatus, 4000);
  pollStatus();
}
function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const st = await res.json();
    setPhase(st.phase, st.message ?? "");
    // Hydrates the UI of an already-running instance (reconciled on boot or
    // after a refresh): reveals the status panel and repaints the GPU from the
    // status itself. Idempotent — in the normal rent() flow it is already done.
    if (st.phase && st.phase !== "idle") {
      $("#step-status").classList.remove("hidden");
      $("#rent-btn").disabled = true;
      if (st.offer) showOffer(st.offer, { tensorParallel: st.offer.numGpus });
    }
    if (st.startedAt && st.phase !== "idle" && st.phase !== "error") {
      startUptime(st.startedAt);
    } else {
      stopUptime();
    }
    if (st.phase === "ready") {
      stopPolling();
      showOpenCode(st);
      enableChat();
      loadHosts(); // the host was auto-recorded as good: refresh the lists
    }
    if (st.phase === "error" || st.phase === "idle") stopPolling();
  } catch {
    /* retries on the next tick */
  }
}

// ── Uptime timer: starts as soon as the instance is created ─────────────────

/** Formats milliseconds as m:ss or h:mm:ss. */
function fmtUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Paints the time elapsed since startedAt in the badge. */
function tickUptime() {
  const el = $("#uptime");
  if (!el || !state.uptime.startedAt) return;
  el.hidden = false;
  el.textContent = `⏱ ${fmtUptime(Date.now() - state.uptime.startedAt)}`;
}

/** Starts the timer anchored to the server's startedAt. Idempotent per timestamp. */
function startUptime(startedAt) {
  if (state.uptime.startedAt === startedAt && state.uptime.timer) return;
  stopUptime();
  state.uptime.startedAt = startedAt;
  tickUptime();
  state.uptime.timer = setInterval(tickUptime, 1000);
}

/** Stops and hides the timer. */
function stopUptime() {
  if (state.uptime.timer) clearInterval(state.uptime.timer);
  state.uptime.timer = null;
  state.uptime.startedAt = null;
  const el = $("#uptime");
  if (el) el.hidden = true;
}

const PHASE_LABELS = {
  idle: "Idle",
  searching: "Searching for a GPU…",
  provisioning: "Provisioning instance…",
  "pulling-model": "Preparing the model…",
  ready: "Ready!",
  error: "Error",
};

function setPhase(phase, msg) {
  $("#phase-dot").className = `dot ${phase}`;
  $("#phase-label").textContent = PHASE_LABELS[phase] ?? phase;
  $("#status-msg").textContent = msg;
}

async function destroy(failed = false) {
  stopPolling();
  stopUptime();
  await fetch("/api/destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(failed ? { failed: true, reason: "user_marked_failed" } : {}),
  });
  setPhase("idle", failed ? "Host banned and instance destroyed." : "Instance destroyed.");
  $("#offer-info").classList.remove("show");
  $("#step-opencode").classList.add("hidden");
  $("#oc-apply-result").classList.add("hidden");
  $("#step-chat").classList.add("hidden");
  $("#rent-btn").disabled = false;
  state.messages = [];
  $("#chat-log").innerHTML = "";
  loadHosts(); // refresh the blocklist after a possible ban
}

// ── Step 3: opencode connection instructions ────────────────────────────────

/** Builds the opencode config JSON for the ready endpoint/model. */
function buildOpenCodeConfig(endpoint, modelId, modelLabel) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "velocity-gpu": {
        npm: "@ai-sdk/openai-compatible",
        name: "Velocity GPU (Vast)",
        options: { baseURL: `${endpoint}/v1`, apiKey: "no-key-needed" },
        models: { [modelId]: { name: modelLabel ?? modelId } },
      },
    },
  };
}

/** Fills in and shows the opencode panel once the GPU is ready. */
function showOpenCode(st) {
  if (!st.endpoint || !st.modelId) return;
  const baseUrl = `${st.endpoint}/v1`;
  $("#oc-endpoint").textContent = baseUrl;
  $("#oc-curl").textContent = `curl ${st.endpoint}/v1/models`;
  const cfg = buildOpenCodeConfig(st.endpoint, st.modelId, st.modelLabel);
  $("#oc-config").textContent = JSON.stringify(cfg, null, 2);
  $("#step-opencode").classList.remove("hidden");

  // Desktop → the app writes the config by itself. Web → manual step-by-step.
  const desktop = state.canAutoConfig === true;
  $("#oc-auto").classList.toggle("hidden", !desktop);
  $("#oc-manual").classList.toggle("hidden", desktop);
  $("#oc-intro").textContent = desktop
    ? "Your GPU is ready. The app will plug the model into opencode automatically."
    : "Your GPU is serving an OpenAI-compatible API through Ollama. Copy the snippets below and plug it into opencode in 30 seconds.";
  if (desktop) applyOpenCode($("#oc-apply-btn"));
}

/**
 * Applies the config to opencode.json automatically through the backend: sets
 * the live endpoint's baseURL and adds the model if it was not there. Zero
 * manual editing.
 */
async function applyOpenCode(btn) {
  const result = $("#oc-apply-result");
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Applying…";
  try {
    const res = await fetch("/api/opencode-sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      result.textContent = `⚠️ ${data.error ?? "Could not apply."}`;
      result.className = "oc-apply-result err";
      return;
    }
    const parts = [data.created ? "opencode.json created" : "opencode.json updated"];
    parts.push(`baseURL → ${data.baseURL}`);
    if (data.providerCreated) parts.push("velocity-gpu provider added");
    if (data.modelAdded) parts.push("model added");
    result.textContent = `✅ ${parts.join(" · ")}. Open opencode and pick the model with /models.`;
    result.className = "oc-apply-result ok";
  } catch (err) {
    result.textContent = `⚠️ ${String(err)}`;
    result.className = "oc-apply-result err";
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

/** Copies an element's text to the clipboard and gives visual feedback. */
async function copyFrom(targetId, btn) {
  const el = document.getElementById(targetId);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent ?? "");
    const prev = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 1500);
  } catch {
    /* no clipboard permission: we do not break the flow */
  }
}

// ── Step 4: streaming chat ──────────────────────────────────────────────────

function enableChat() {
  $("#step-chat").classList.remove("hidden");
  $("#chat-input").disabled = false;
  $("#send-btn").disabled = false;
  $("#chat-input").focus();
}

function appendMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("#chat-log").appendChild(div);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return div;
}

async function sendChat(evt) {
  evt.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMsg("user", text);
  state.messages.push({ role: "user", content: text });

  $("#send-btn").disabled = true;
  const assistantDiv = appendMsg("assistant", "");
  let acc = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.messages }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      assistantDiv.textContent = `⚠️ ${err.error ?? "Chat error"}`;
      $("#send-btn").disabled = false;
      return;
    }
    // Parses the OpenAI-style SSE stream (`data: {json}` / `data: [DONE]` lines).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            acc += delta;
            assistantDiv.textContent = acc;
            $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
          }
        } catch {
          /* partial fragment: completed in the next chunk */
        }
      }
    }
    state.messages.push({ role: "assistant", content: acc });
  } catch (err) {
    assistantDiv.textContent = `⚠️ ${String(err)}`;
  } finally {
    $("#send-btn").disabled = false;
    $("#chat-input").focus();
  }
}

// ── Host memory: persisted blocklist/allowlist ──────────────────────────────

/** Fetches the host history and repaints both lists (banned / good). */
async function loadHosts() {
  try {
    const res = await fetch("/api/hosts");
    if (!res.ok) return;
    const { good, bad } = await res.json();
    renderHostList($("#bad-hosts"), bad, "bad");
    renderHostList($("#good-hosts"), good, "good");
    $("#bad-count").textContent = String(bad.length);
    $("#good-count").textContent = String(good.length);
  } catch {
    /* not showing the history is not critical */
  }
}

/** Paints a list of hosts with its "forget" button. `list` = 'good' | 'bad'. */
function renderHostList(ul, hosts, list) {
  ul.innerHTML = "";
  if (!hosts || hosts.length === 0) {
    const li = document.createElement("li");
    li.className = "hosts-empty";
    li.textContent = list === "bad" ? "No banned hosts yet." : "No hosts recorded yet.";
    ul.appendChild(li);
    return;
  }
  for (const h of hosts) {
    const li = document.createElement("li");
    li.className = "hosts-item";
    const meta =
      list === "bad"
        ? `${h.reason ?? "failure"} · failed ${h.failCount ?? 1}×`
        : `${h.successCount ?? 1}× OK${h.dphTotal ? ` · $${Number(h.dphTotal).toFixed(3)}/h` : ""}`;
    li.innerHTML = `
      <div class="hosts-info">
        <b>${h.gpuName ?? "GPU"}</b> <span class="hosts-id">#${h.machineId}</span>
        <span class="hosts-meta">${meta}</span>
      </div>
      <button class="hosts-forget" data-list="${list}" data-id="${h.machineId}"
        title="${list === "bad" ? "Give it another chance" : "Forget this host"}">
        ${list === "bad" ? "♻️ Forgive" : "✕ Forget"}
      </button>`;
    ul.appendChild(li);
  }
}

/** Removes a host from a list ('good'|'bad') and repaints. */
async function forgetHost(list, machineId) {
  try {
    const res = await fetch("/api/hosts/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, machineId: Number(machineId) }),
    });
    if (res.ok) {
      const { good, bad } = await res.json();
      renderHostList($("#bad-hosts"), bad, "bad");
      renderHostList($("#good-hosts"), good, "good");
      $("#bad-count").textContent = String(bad.length);
      $("#good-count").textContent = String(good.length);
    }
  } catch {
    /* can be retried manually */
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

$("#rent-btn").addEventListener("click", rent);
$("#destroy-btn").addEventListener("click", () => destroy(false));
$("#mark-failed-btn").addEventListener("click", () => destroy(true));
$("#oc-apply-btn").addEventListener("click", (e) => applyOpenCode(e.currentTarget));
$("#chat-form").addEventListener("submit", sendChat);
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".oc-copy");
  if (btn) copyFrom(btn.dataset.copy, btn);
  const forget = e.target.closest?.(".hosts-forget");
  if (forget) forgetHost(forget.dataset.list, forget.dataset.id);
});
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat(e);
  }
});

loadModels();
loadAccount();
loadEnvironment();
loadHosts();
// Hydrates the state of an already-running instance (the backend's
// reconciliation adopts it on startup): without this, a refresh left the UI
// blank even though the GPU was ready.
startPolling();
