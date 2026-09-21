/* ============================================================
   FpEnhancer — Dashboard logic (bulk workflow)
   Talks to the same-origin FastAPI backend:
     GET  /health        -> API status
     GET  /auth/status   -> session check (does NOT extend session)
     POST /auth/ping     -> meaningful activity heartbeat (extends session)
     POST /logout        -> end session
     POST /enhance       -> multipart field "file" -> image/png (auth required)
   ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- Config ----------
  const ENHANCE_ENDPOINT = "/enhance";
  const HEALTH_ENDPOINTS = ["/health"];
  const REQUEST_TIMEOUT_MS = 180000; // 3 min — CPU inference can be slow
  const MAX_FILE_MB = 25;
  const MAX_BATCH = 200;
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp", "image/x-bmp"];
  const ALLOWED_EXT = /\.(jpe?g|png|bmp)$/i;
  const CONCURRENCY = 1; // CPU server: strictly sequential

  // Idle session timeout (server is the source of truth; these are UI defaults)
  let IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const WARN_BEFORE_MS = 30 * 1000;
  const ACTIVITY_PING_THROTTLE_MS = 20 * 1000;

  // ---------- Elements ----------
  const el = {
    apiStatus: $("apiStatus"),
    apiStatusText: $("apiStatusText"),
    logoutBtn: $("logoutBtn"),
    dropzone: $("dropzone"),
    fileInput: $("fileInput"),
    chooseBtn: $("chooseBtn"),
    uploadError: $("uploadError"),
    emptyState: $("emptyState"),
    batch: $("batch"),
    batchCount: $("batchCount"),
    progressText: $("progressText"),
    progressFill: $("progressFill"),
    statPending: $("statPending"),
    statProcessing: $("statProcessing"),
    statDone: $("statDone"),
    statFailed: $("statFailed"),
    batchNote: $("batchNote"),
    cards: $("cards"),
    cardTemplate: $("cardTemplate"),
    enhanceAllBtn: $("enhanceAllBtn"),
    downloadZipBtn: $("downloadZipBtn"),
    addMoreBtn: $("addMoreBtn"),
    clearAllBtn: $("clearAllBtn"),
    // compare modal
    compareModal: $("compareModal"),
    compareTitle: $("compareTitle"),
    compareClose: $("compareClose"),
    compareZoomOrig: $("compareZoomOrig"),
    compareZoomEnh: $("compareZoomEnh"),
    compare: $("compare"),
    compareBefore: $("compareBefore"),
    compareAfter: $("compareAfter"),
    compareBeforeWrap: $("compareBeforeWrap"),
    compareHandle: $("compareHandle"),
    compareRange: $("compareRange"),
    // lightbox
    lightbox: $("lightbox"),
    lightboxImg: $("lightboxImg"),
    lightboxStage: $("lightboxStage"),
    lightboxTitle: $("lightboxTitle"),
    lbZoomIn: $("lbZoomIn"),
    lbZoomOut: $("lbZoomOut"),
    lbReset: $("lbReset"),
    lbFullscreen: $("lbFullscreen"),
    lbClose: $("lbClose"),
    lbZoomLabel: $("lbZoomLabel"),
    // idle
    idleModal: $("idleModal"),
    idleSeconds: $("idleSeconds"),
    stayBtn: $("stayBtn"),
    idleLogoutBtn: $("idleLogoutBtn"),
    toast: $("toast"),
  };

  // ---------- Batch state ----------
  /** @type {Map<string, Item>} */
  const items = new Map();
  let order = []; // insertion order of item ids
  let nextId = 1;
  const batch = { running: false, cancelRequested: false, active: 0 };
  let compareItemId = null;

  class AppError extends Error {
    constructor(message) { super(message); this.name = "AppError"; }
  }

  // ---------- Helpers ----------
  function show(node, text) {
    if (text !== undefined) node.textContent = text;
    node.hidden = false;
  }
  function hide(node) { node.hidden = true; }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function revoke(url) { if (url) { try { URL.revokeObjectURL(url); } catch (_) {} } }

  function loadImageDims(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = url;
    });
  }

  function validateFile(file) {
    if (!file) return "No file selected.";
    const typeOk = ALLOWED_TYPES.includes(file.type) || (!file.type && ALLOWED_EXT.test(file.name));
    const extOk = ALLOWED_EXT.test(file.name || "");
    if (!typeOk && !extOk) return "Unsupported format. Please use JPG, JPEG, PNG or BMP.";
    if (file.size === 0) return "The selected file is empty.";
    if (file.size > MAX_FILE_MB * 1024 * 1024) return `File is too large. Maximum size is ${MAX_FILE_MB} MB.`;
    return null;
  }

  /** "finger1.jpg" -> "finger1"; strips path separators & unsafe chars. */
  function baseName(name) {
    let base = String(name || "image").split(/[\\/]/).pop();
    base = base.replace(/\.[^.]+$/, "");
    base = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
    return base || "image";
  }

  function enhancedName(item) {
    return `${baseName(item.file.name)}_enhanced.png`;
  }

  let toastTimer = null;
  function toast(msg, kind = "info") {
    el.toast.textContent = msg;
    el.toast.className = `toast toast--${kind} toast--show`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.classList.remove("toast--show"); setTimeout(() => hide(el.toast), 300); }, 3200);
  }

  // ---------- API status ----------
  async function checkApi() {
    el.apiStatus.className = "api-status api-status--checking";
    el.apiStatusText.textContent = "Checking API…";

    for (const path of HEALTH_ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(path, { method: "GET", cache: "no-store", signal: ctrl.signal, headers: { Accept: "application/json" } });
        clearTimeout(t);
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) continue;
        const data = await res.json();
        if (data && data.status === "online") {
          el.apiStatus.className = "api-status api-status--online";
          el.apiStatusText.textContent = "API Online";
          el.apiStatus.title = `${data.service || "FpEnhancer"} • ${data.device || "CPU"}`;
          return true;
        }
      } catch (_) { /* try next */ }
    }
    el.apiStatus.className = "api-status api-status--offline";
    el.apiStatusText.textContent = "API Offline";
    el.apiStatus.title = "Could not reach the FpEnhancer API";
    return false;
  }

  // ============================================================
  //  SESSION / IDLE TIMEOUT
  //  The server enforces the timeout independently; this is UX.
  // ============================================================
  const idle = { lastActivity: Date.now(), lastPing: 0, warnTimer: null, logoutTimer: null, countdown: null, warning: false, loggedOut: false };

  function redirectToLogin(reason) {
    if (idle.loggedOut) return;
    idle.loggedOut = true;
    location.replace(`/login${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`);
  }

  async function serverLogout(reason) {
    clearIdleTimers();
    try {
      await fetch("/logout", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true });
    } catch (_) { /* cookie will also expire server-side */ }
    redirectToLogin(reason);
  }

  function clearIdleTimers() {
    clearTimeout(idle.warnTimer);
    clearTimeout(idle.logoutTimer);
    clearInterval(idle.countdown);
    idle.warnTimer = idle.logoutTimer = idle.countdown = null;
  }

  function scheduleIdleTimers() {
    clearIdleTimers();
    idle.warnTimer = setTimeout(showIdleWarning, Math.max(1000, IDLE_TIMEOUT_MS - WARN_BEFORE_MS));
    idle.logoutTimer = setTimeout(() => serverLogout("timeout"), IDLE_TIMEOUT_MS);
  }

  function showIdleWarning() {
    idle.warning = true;
    el.idleModal.classList.add("idle--open");
    el.idleModal.setAttribute("aria-hidden", "false");
    const deadline = idle.lastActivity + IDLE_TIMEOUT_MS;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.idleSeconds.textContent = String(left);
      if (left <= 0) clearInterval(idle.countdown);
    };
    tick();
    idle.countdown = setInterval(tick, 250);
    el.stayBtn.focus();
  }

  function hideIdleWarning() {
    idle.warning = false;
    clearInterval(idle.countdown);
    el.idleModal.classList.remove("idle--open");
    el.idleModal.setAttribute("aria-hidden", "true");
  }

  /** Tell the server this was real activity (throttled). */
  async function pingServer(force = false) {
    const now = Date.now();
    if (!force && now - idle.lastPing < ACTIVITY_PING_THROTTLE_MS) return;
    idle.lastPing = now;
    try {
      const res = await fetch("/auth/ping", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) { redirectToLogin("timeout"); return; }
      if (res.ok) {
        const data = await res.json();
        if (data && Number.isFinite(data.idle_timeout)) IDLE_TIMEOUT_MS = data.idle_timeout * 1000;
      }
    } catch (_) { /* offline: keep local timer */ }
  }

  /**
   * Meaningful activity: uploads, removals, enhance, downloads, clear, and
   * normal dashboard interaction (clicks / key presses / touches).
   * @param {boolean} [notifyServer=true]
   */
  function activity(notifyServer = true) {
    if (idle.loggedOut) return;
    idle.lastActivity = Date.now();
    if (idle.warning) hideIdleWarning();
    scheduleIdleTimers();
    if (notifyServer) pingServer(false);
  }

  /** The /enhance call itself already refreshes the server timer. */
  function activityLocalOnly() { activity(false); }

  async function verifySession() {
    try {
      const res = await fetch("/auth/status", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.authenticated) { redirectToLogin("timeout"); return; }
      if (Number.isFinite(data.idle_timeout)) IDLE_TIMEOUT_MS = data.idle_timeout * 1000;
      if (Number.isFinite(data.remaining)) {
        // Sync local timer with the server's remaining idle time.
        idle.lastActivity = Date.now() - (IDLE_TIMEOUT_MS - data.remaining * 1000);
        if (data.remaining * 1000 <= WARN_BEFORE_MS) {
          clearIdleTimers();
          idle.logoutTimer = setTimeout(() => serverLogout("timeout"), data.remaining * 1000);
          showIdleWarning();
        } else {
          clearIdleTimers();
          idle.warnTimer = setTimeout(showIdleWarning, data.remaining * 1000 - WARN_BEFORE_MS);
          idle.logoutTimer = setTimeout(() => serverLogout("timeout"), data.remaining * 1000);
        }
      }
    } catch (_) { /* ignore */ }
  }

  // Normal interaction counts as activity (throttled server pings).
  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, (e) => {
      // Clicks inside the idle warning are handled by its buttons only.
      if (el.idleModal.contains(e.target)) return;
      activity(true);
    }, { passive: true })
  );

  el.stayBtn.addEventListener("click", async () => {
    hideIdleWarning();
    idle.lastActivity = Date.now();
    scheduleIdleTimers();
    await pingServer(true);
    toast("You're still logged in.", "success");
  });
  el.idleLogoutBtn.addEventListener("click", () => serverLogout("logout"));
  el.logoutBtn.addEventListener("click", () => serverLogout("logout"));

  // Re-check the server when the tab becomes visible again (timers are
  // throttled in background tabs; the server decides anyway).
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { verifySession(); checkApi(); } });

  // ============================================================
  //  ITEMS / CARDS
  // ============================================================
  /**
   * @typedef {Object} Item
   * @property {string} id
   * @property {File} file
   * @property {string} originalUrl
   * @property {string|null} enhancedUrl
   * @property {Blob|null} enhancedBlob
   * @property {{w:number,h:number}|null} originalDims
   * @property {{w:number,h:number}|null} enhancedDims
   * @property {"pending"|"processing"|"done"|"failed"} status
   * @property {string} error
   * @property {HTMLElement} node
   * @property {AbortController|null} ctrl
   */

  const STATUS_LABEL = { pending: "Pending", processing: "Processing...", done: "Completed", failed: "Failed" };

  function counts() {
    const c = { pending: 0, processing: 0, done: 0, failed: 0, total: items.size };
    for (const it of items.values()) c[it.status]++;
    return c;
  }

  function render() {
    const c = counts();
    const has = c.total > 0;
    el.emptyState.hidden = has;
    el.batch.hidden = !has;
    el.batchCount.textContent = String(c.total);
    el.progressText.textContent = `${c.done} / ${c.total} completed`;
    const pct = c.total ? Math.round(((c.done + c.failed) / c.total) * 100) : 0;
    el.progressFill.style.width = `${pct}%`;
    el.progressFill.classList.toggle("progress__fill--partial", c.failed > 0);
    el.statPending.textContent = String(c.pending);
    el.statProcessing.textContent = String(c.processing);
    el.statDone.textContent = String(c.done);
    el.statFailed.textContent = String(c.failed);

    const queueable = c.pending + c.failed;
    el.enhanceAllBtn.disabled = batch.running || queueable === 0;
    el.enhanceAllBtn.innerHTML = batch.running
      ? `<span class="spinner" aria-hidden="true"></span> Enhancing ${c.done + c.failed + 1 > c.total ? c.total : c.done + c.failed + 1} of ${c.total}…`
      : c.done > 0 && queueable > 0 && c.failed > 0 && c.pending === 0
        ? `<span class="btn__sparkle" aria-hidden="true">✨</span> Retry Failed (${c.failed})`
        : `<span class="btn__sparkle" aria-hidden="true">✨</span> Enhance All${queueable && queueable !== c.total ? ` (${queueable})` : ""}`;
    el.downloadZipBtn.disabled = c.done === 0 || zipBusy;
    el.clearAllBtn.disabled = batch.running;
    el.addMoreBtn.disabled = batch.running;

    if (batch.running) {
      show(el.batchNote, "Images are enhanced one at a time on the CPU server. Please keep this tab open.");
    } else if (has && c.done === c.total) {
      show(el.batchNote, "All images enhanced. Download them individually or as a ZIP.");
    } else if (has && c.failed > 0 && c.processing === 0 && c.pending === 0) {
      show(el.batchNote, `${c.failed} image${c.failed > 1 ? "s" : ""} failed. Use Retry on the card or "Retry Failed".`);
    } else {
      hide(el.batchNote);
    }
  }

  function setStatus(item, status, error) {
    item.status = status;
    if (error !== undefined) item.error = error;
    else if (status !== "failed") item.error = "";
    error = item.error;
    const node = item.node;
    node.dataset.status = status;
    const badge = node.querySelector(".status");
    badge.className = `status status--${status}`;
    badge.querySelector(".status__text").textContent = STATUS_LABEL[status];

    node.querySelector(".fp-card__placeholder--pending").hidden = status !== "pending";
    node.querySelector(".fp-card__placeholder--processing").hidden = status !== "processing";
    node.querySelector(".fp-card__placeholder--failed").hidden = status !== "failed";
    const enh = node.querySelector(".fp-card__img--enh");
    enh.hidden = status !== "done";
    if (status === "done" && item.enhancedUrl) enh.src = item.enhancedUrl;
    else enh.removeAttribute("src");

    const errBox = node.querySelector(".fp-card__error");
    if (status === "failed" && error) show(errBox, error); else hide(errBox);

    node.querySelector('[data-action="download"]').hidden = status !== "done";
    node.querySelector('[data-action="compare"]').hidden = status !== "done";
    node.querySelector('[data-action="enhance"]').hidden = status !== "pending";
    node.querySelector('[data-action="retry"]').hidden = status !== "failed";
    const removeBtn = node.querySelector('[data-action="remove"]');
    removeBtn.disabled = status === "processing";
    node.querySelector('[data-action="enhance"]').disabled = batch.running;
    node.querySelector('[data-action="retry"]').disabled = batch.running;

    const meta = node.querySelector(".fp-card__meta");
    const parts = [formatBytes(item.file.size)];
    if (item.originalDims) parts.push(`${item.originalDims.w} × ${item.originalDims.h} px`);
    if (status === "done" && item.enhancedBlob) parts.push(`→ ${formatBytes(item.enhancedBlob.size)} PNG`);
    meta.textContent = parts.join(" • ");
    render();
  }

  function createCard(item) {
    const frag = el.cardTemplate.content.cloneNode(true);
    const node = frag.querySelector(".fp-card");
    node.dataset.id = item.id;
    const name = node.querySelector(".fp-card__name");
    name.textContent = item.file.name;
    name.title = item.file.name;
    const orig = node.querySelector(".fp-card__img--orig");
    orig.src = item.originalUrl;
    orig.alt = `Original: ${item.file.name}`;
    node.querySelector(".fp-card__img--enh").alt = `Enhanced: ${item.file.name}`;
    item.node = node;
    el.cards.appendChild(node);
    setStatus(item, "pending");
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    hide(el.uploadError);
    const errors = [];
    let added = 0;

    for (const file of files) {
      if (items.size >= MAX_BATCH) { errors.push(`Batch limit reached (${MAX_BATCH} images).`); break; }
      const err = validateFile(file);
      if (err) { errors.push(`${file.name}: ${err}`); continue; }

      const id = `img_${nextId++}`;
      const originalUrl = URL.createObjectURL(file);
      let dims = null;
      try { dims = await loadImageDims(originalUrl); }
      catch (_) { revoke(originalUrl); errors.push(`${file.name}: could not be read as an image.`); continue; }

      /** @type {Item} */
      const item = { id, file, originalUrl, enhancedUrl: null, enhancedBlob: null, originalDims: dims, enhancedDims: null, status: "pending", error: "", node: null, ctrl: null };
      items.set(id, item);
      order.push(id);
      createCard(item);
      added++;
    }

    el.fileInput.value = "";
    if (errors.length) show(el.uploadError, errors.slice(0, 4).join(" ") + (errors.length > 4 ? ` (+${errors.length - 4} more)` : ""));
    if (added) {
      activity(true);
      if (added > 1) toast(`${added} images added.`, "success");
      if (items.size === added) el.batch.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    render();
  }

  function removeItem(id) {
    const item = items.get(id);
    if (!item || item.status === "processing") return;
    revoke(item.originalUrl);
    revoke(item.enhancedUrl);
    item.node.classList.add("fp-card--leaving");
    const node = item.node;
    setTimeout(() => node.remove(), 220);
    items.delete(id);
    order = order.filter((x) => x !== id);
    if (compareItemId === id) closeCompare();
    activity(true);
    render();
  }

  function clearAll() {
    if (batch.running) return;
    for (const item of items.values()) { revoke(item.originalUrl); revoke(item.enhancedUrl); }
    items.clear();
    order = [];
    el.cards.innerHTML = "";
    el.fileInput.value = "";
    hide(el.uploadError);
    closeCompare();
    activity(true);
    render();
    toast("Batch cleared.", "info");
  }

  // ============================================================
  //  ENHANCE (REAL API CALL — existing POST /enhance, one image)
  // ============================================================
  async function httpError(response) {
    let detail = "";
    try {
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const data = await response.json();
        if (typeof data.detail === "string") detail = data.detail;
        else if (Array.isArray(data.detail) && data.detail[0]?.msg) detail = data.detail[0].msg;
      }
    } catch (_) { /* ignore */ }

    if (response.status === 401) return new AppError("__AUTH__");
    if (response.status === 400) return new AppError(detail || "The uploaded file was rejected as an invalid image.");
    if (response.status === 413) return new AppError("The image is too large for the server to accept.");
    if (response.status === 415 || response.status === 422) return new AppError(detail || "The server could not accept this file format.");
    if (response.status === 429) return new AppError("Too many requests. Please wait a moment and try again.");
    if (response.status === 502 || response.status === 503 || response.status === 504) return new AppError("The processing server is temporarily unavailable. Please try again shortly.");
    if (response.status >= 500) return new AppError("The server encountered an error while enhancing the image.");
    return new AppError(detail || `Request failed (HTTP ${response.status}).`);
  }

  function friendlyMessage(e) {
    if (e && e.name === "AbortError") return "The request timed out. The server may be busy — please retry.";
    if (e instanceof AppError) return e.message;
    if (e instanceof TypeError) return "Network error. Please check your connection and make sure the API is reachable.";
    return "Unexpected error.";
  }

  async function enhanceItem(item) {
    if (!items.has(item.id) || item.status === "processing") return;
    const err = validateFile(item.file);
    if (err) { setStatus(item, "failed", err); return; }

    revoke(item.enhancedUrl);
    item.enhancedUrl = null; item.enhancedBlob = null; item.enhancedDims = null;
    setStatus(item, "processing");
    activityLocalOnly(); // the authenticated /enhance call refreshes the server timer

    const formData = new FormData();
    formData.append("file", item.file, item.file.name);

    const ctrl = new AbortController();
    item.ctrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      // NOTE: do NOT set Content-Type — the browser sets the multipart boundary.
      const response = await fetch(ENHANCE_ENDPOINT, { method: "POST", body: formData, signal: ctrl.signal, credentials: "same-origin" });
      if (!response.ok) throw await httpError(response);

      const blob = await response.blob();
      if (!blob || blob.size === 0) throw new AppError("The server returned an empty response.");
      if (blob.type && !blob.type.startsWith("image/")) throw new AppError("The server returned an unexpected response instead of an image.");

      const url = URL.createObjectURL(blob);
      let dims;
      try { dims = await loadImageDims(url); }
      catch (_) { revoke(url); throw new AppError("The returned image could not be displayed."); }

      if (!items.has(item.id)) { revoke(url); return; } // removed meanwhile
      item.enhancedBlob = blob; item.enhancedUrl = url; item.enhancedDims = dims;
      setStatus(item, "done");
      activityLocalOnly();
    } catch (e) {
      if (e instanceof AppError && e.message === "__AUTH__") {
        setStatus(item, "failed", "Session expired.");
        batch.cancelRequested = true;
        redirectToLogin("timeout");
        return;
      }
      if (items.has(item.id)) setStatus(item, "failed", friendlyMessage(e));
      checkApi();
    } finally {
      clearTimeout(timer);
      item.ctrl = null;
    }
  }

  /** Sequential queue: processes pending (and optionally failed) items. */
  async function runQueue(ids) {
    if (batch.running) return;
    batch.running = true;
    batch.cancelRequested = false;
    render();
    for (const item of items.values()) setStatus(item, item.status); // refresh disabled states

    const queue = ids.slice();
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && !batch.cancelRequested) {
        const id = queue.shift();
        const item = items.get(id);
        if (!item || item.status === "processing" || item.status === "done") continue;
        await enhanceItem(item); // never throws — failures are per-item
        render();
      }
    });
    await Promise.all(workers);

    batch.running = false;
    for (const item of items.values()) setStatus(item, item.status);
    render();

    const c = counts();
    if (!batch.cancelRequested) {
      if (c.failed === 0 && c.done === c.total) toast(`All ${c.total} image${c.total > 1 ? "s" : ""} enhanced.`, "success");
      else if (c.failed > 0) toast(`${c.done} completed, ${c.failed} failed.`, "warn");
    }
  }

  function enhanceAll() {
    if (batch.running) return;
    const ids = order.filter((id) => { const s = items.get(id)?.status; return s === "pending" || s === "failed"; });
    if (!ids.length) return;
    activity(true);
    runQueue(ids);
  }

  function retryItem(id) {
    if (batch.running) return;
    const item = items.get(id);
    if (!item || item.status === "processing") return;
    activity(true);
    runQueue([id]);
  }

  // ============================================================
  //  DOWNLOADS
  // ============================================================
  function triggerDownload(blobOrUrl, filename) {
    const url = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (blobOrUrl instanceof Blob) setTimeout(() => revoke(url), 4000);
  }

  function downloadItem(id) {
    const item = items.get(id);
    if (!item || item.status !== "done" || !item.enhancedBlob) return;
    activity(true);
    triggerDownload(item.enhancedBlob, enhancedName(item));
  }

  /** Unique names inside the ZIP: a_enhanced.png, a_enhanced (2).png, ... */
  function uniqueZipName(taken, name) {
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
    const stem = name.replace(/\.png$/i, "");
    let i = 2;
    let candidate;
    do { candidate = `${stem} (${i++}).png`; } while (taken.has(candidate.toLowerCase()));
    taken.add(candidate.toLowerCase());
    return candidate;
  }

  let zipBusy = false;
  async function downloadZip() {
    if (zipBusy) return;
    const done = order.map((id) => items.get(id)).filter((it) => it && it.status === "done" && it.enhancedBlob);
    if (!done.length) { toast("No enhanced images to download yet.", "warn"); return; }
    if (typeof JSZip === "undefined") { toast("ZIP library failed to load. Please refresh the page.", "error"); return; }

    zipBusy = true;
    activity(true);
    const original = el.downloadZipBtn.innerHTML;
    el.downloadZipBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Creating ZIP…`;
    render();
    try {
      const zip = new JSZip();
      const taken = new Set();
      for (const item of done) {
        zip.file(uniqueZipName(taken, enhancedName(item)), item.enhancedBlob, { binary: true, date: new Date() });
      }
      // PNG is already compressed — STORE keeps the browser responsive.
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      triggerDownload(blob, `fingerprints_enhanced_${stamp}.zip`);
      toast(`ZIP with ${done.length} image${done.length > 1 ? "s" : ""} ready.`, "success");
    } catch (e) {
      toast("Could not create the ZIP file.", "error");
    } finally {
      zipBusy = false;
      el.downloadZipBtn.innerHTML = original;
      render();
    }
  }

  // ============================================================
  //  BEFORE / AFTER COMPARE (per card, in a modal)
  // ============================================================
  function openCompare(id) {
    const item = items.get(id);
    if (!item || item.status !== "done") return;
    compareItemId = id;
    el.compareTitle.textContent = item.file.name;
    el.compareBefore.src = item.originalUrl;
    el.compareAfter.src = item.enhancedUrl;
    const d = item.enhancedDims || item.originalDims || { w: 1, h: 1 };
    el.compare.style.aspectRatio = `${d.w} / ${d.h}`;
    el.compareModal.classList.add("modal--open");
    el.compareModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setCompare(50);
    requestAnimationFrame(syncCompareWidth);
    setTimeout(syncCompareWidth, 120);
  }

  function closeCompare() {
    if (!el.compareModal.classList.contains("modal--open")) { compareItemId = null; return; }
    compareItemId = null;
    el.compareModal.classList.remove("modal--open");
    el.compareModal.setAttribute("aria-hidden", "true");
    if (!el.lightbox.classList.contains("lightbox--open")) document.body.style.overflow = "";
    el.compareBefore.removeAttribute("src");
    el.compareAfter.removeAttribute("src");
  }

  function syncCompareWidth() {
    // Ensure the "before" image is the same rendered size as the "after" image.
    const rect = el.compare.getBoundingClientRect();
    el.compareBefore.style.width = `${rect.width}px`;
    el.compareBefore.style.height = `${rect.height}px`;
  }

  function setCompare(pct) {
    pct = Math.max(0, Math.min(100, pct));
    el.compareBeforeWrap.style.width = `${pct}%`;
    el.compareHandle.style.left = `${pct}%`;
    el.compareRange.value = String(pct);
  }

  function pointerToPct(clientX) {
    const rect = el.compare.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  }

  let dragging = false;
  el.compare.addEventListener("pointerdown", (e) => {
    dragging = true;
    el.compare.setPointerCapture?.(e.pointerId);
    setCompare(pointerToPct(e.clientX));
  });
  el.compare.addEventListener("pointermove", (e) => { if (dragging) setCompare(pointerToPct(e.clientX)); });
  const stopDrag = () => { dragging = false; };
  el.compare.addEventListener("pointerup", stopDrag);
  el.compare.addEventListener("pointercancel", stopDrag);
  el.compareRange.addEventListener("input", (e) => setCompare(Number(e.target.value)));
  window.addEventListener("resize", () => { if (el.compareModal.classList.contains("modal--open")) syncCompareWidth(); });
  el.compareClose.addEventListener("click", closeCompare);
  el.compareModal.addEventListener("click", (e) => { if (e.target === el.compareModal) closeCompare(); });
  el.compareZoomOrig.addEventListener("click", () => { const it = items.get(compareItemId); if (it) openLightbox(it.originalUrl, `ORIGINAL — ${it.file.name}`); });
  el.compareZoomEnh.addEventListener("click", () => { const it = items.get(compareItemId); if (it) openLightbox(it.enhancedUrl, `ENHANCED — ${it.file.name}`); });

  // ============================================================
  //  LIGHTBOX (zoom + fullscreen) — preserved feature
  // ============================================================
  const lb = { scale: 1, min: 0.2, max: 12, x: 0, y: 0, natural: { w: 0, h: 0 }, drag: null, pinch: null };

  function openLightbox(url, title) {
    if (!url) return;
    el.lightboxTitle.textContent = title || "Image";
    el.lightboxImg.onload = () => {
      lb.natural = { w: el.lightboxImg.naturalWidth, h: el.lightboxImg.naturalHeight };
      fitToStage();
    };
    el.lightboxImg.src = url;
    el.lightbox.classList.add("lightbox--open");
    el.lightbox.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    el.lightbox.classList.remove("lightbox--open");
    el.lightbox.setAttribute("aria-hidden", "true");
    if (!el.compareModal.classList.contains("modal--open")) document.body.style.overflow = "";
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  function fitToStage() {
    const stage = el.lightboxStage.getBoundingClientRect();
    const { w, h } = lb.natural;
    if (!w || !h) return;
    const scale = Math.min(stage.width / w, stage.height / h, 1) * 0.96;
    lb.scale = scale;
    lb.x = (stage.width - w * scale) / 2;
    lb.y = (stage.height - h * scale) / 2;
    applyTransform();
  }

  function applyTransform() {
    el.lightboxImg.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
    el.lbZoomLabel.textContent = `${Math.round(lb.scale * 100)}%`;
  }

  function zoomAt(factor, cx, cy) {
    const stage = el.lightboxStage.getBoundingClientRect();
    const px = (cx ?? stage.width / 2 + stage.left) - stage.left;
    const py = (cy ?? stage.height / 2 + stage.top) - stage.top;
    const newScale = Math.max(lb.min, Math.min(lb.max, lb.scale * factor));
    const ratio = newScale / lb.scale;
    lb.x = px - (px - lb.x) * ratio;
    lb.y = py - (py - lb.y) * ratio;
    lb.scale = newScale;
    applyTransform();
  }

  el.lightboxStage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  const pointers = new Map();
  el.lightboxStage.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.lightboxStage.setPointerCapture?.(e.pointerId);
    if (pointers.size === 1) lb.drag = { sx: e.clientX, sy: e.clientY, ox: lb.x, oy: lb.y };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lb.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: lb.scale };
      lb.drag = null;
    }
  });
  el.lightboxStage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && lb.pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = (dist / lb.pinch.dist) * lb.pinch.scale / lb.scale;
      zoomAt(factor, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (lb.drag) {
      lb.x = lb.drag.ox + (e.clientX - lb.drag.sx);
      lb.y = lb.drag.oy + (e.clientY - lb.drag.sy);
      applyTransform();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lb.pinch = null;
    if (pointers.size === 0) lb.drag = null;
    else if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      lb.drag = { sx: p.x, sy: p.y, ox: lb.x, oy: lb.y };
    }
  };
  el.lightboxStage.addEventListener("pointerup", endPointer);
  el.lightboxStage.addEventListener("pointercancel", endPointer);
  el.lightboxStage.addEventListener("dblclick", (e) => zoomAt(lb.scale < 1 ? 1 / lb.scale : 2, e.clientX, e.clientY));

  el.lbZoomIn.addEventListener("click", () => zoomAt(1.25));
  el.lbZoomOut.addEventListener("click", () => zoomAt(1 / 1.25));
  el.lbReset.addEventListener("click", fitToStage);
  el.lbClose.addEventListener("click", closeLightbox);
  el.lbFullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.lightbox.requestFullscreen?.();
    } catch (_) { /* unsupported (e.g. iOS Safari) — the overlay already fills the viewport */ }
    setTimeout(fitToStage, 150);
  });
  document.addEventListener("fullscreenchange", () => setTimeout(fitToStage, 100));
  window.addEventListener("resize", () => { if (el.lightbox.classList.contains("lightbox--open")) fitToStage(); });
  document.addEventListener("keydown", (e) => {
    if (el.lightbox.classList.contains("lightbox--open")) {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "+" || e.key === "=") zoomAt(1.25);
      if (e.key === "-") zoomAt(1 / 1.25);
      if (e.key === "0") fitToStage();
      return;
    }
    if (e.key === "Escape" && el.compareModal.classList.contains("modal--open")) closeCompare();
  });

  // ============================================================
  //  CARD ACTIONS (event delegation)
  // ============================================================
  el.cards.addEventListener("click", (e) => {
    const card = e.target.closest(".fp-card");
    if (!card) return;
    const id = card.dataset.id;
    const item = items.get(id);
    if (!item) return;

    const btn = e.target.closest("[data-action]");
    if (btn) {
      switch (btn.dataset.action) {
        case "download": downloadItem(id); break;
        case "compare": openCompare(id); break;
        case "enhance": retryItem(id); break;
        case "retry": retryItem(id); break;
        case "remove": removeItem(id); break;
      }
      return;
    }

    const img = e.target.closest(".fp-card__img");
    if (img && img.src) {
      const isEnh = img.classList.contains("fp-card__img--enh");
      openLightbox(isEnh ? item.enhancedUrl : item.originalUrl, `${isEnh ? "ENHANCED" : "ORIGINAL"} — ${item.file.name}`);
    }
  });

  // ============================================================
  //  UPLOAD / DROPZONE
  // ============================================================
  const openPicker = () => { if (!batch.running) el.fileInput.click(); };
  el.chooseBtn.addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });
  el.addMoreBtn.addEventListener("click", openPicker);
  el.dropzone.addEventListener("click", (e) => { if (e.target === el.chooseBtn || el.chooseBtn.contains(e.target)) return; openPicker(); });
  el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
  el.fileInput.addEventListener("change", (e) => { if (e.target.files?.length) addFiles(e.target.files); });

  ["dragenter", "dragover"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); el.dropzone.classList.add("dropzone--over"); })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); if (evt === "dragleave" && el.dropzone.contains(e.relatedTarget)) return; el.dropzone.classList.remove("dropzone--over"); })
  );
  el.dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    el.dropzone.classList.remove("dropzone--over");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Allow dropping anywhere on the page
  window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("is-dragging"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("is-dragging"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("is-dragging");
    if (el.dropzone.contains(e.target)) return; // already handled
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Paste image(s) from clipboard
  window.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.type.startsWith("image/"))
      .map((i, idx) => { const f = i.getAsFile(); return f ? new File([f], f.name || `pasted_fingerprint_${idx + 1}.png`, { type: f.type }) : null; })
      .filter(Boolean);
    if (files.length) addFiles(files);
  });

  // ---------- Toolbar wiring ----------
  el.enhanceAllBtn.addEventListener("click", enhanceAll);
  el.downloadZipBtn.addEventListener("click", downloadZip);
  el.clearAllBtn.addEventListener("click", clearAll);

  window.addEventListener("beforeunload", (e) => {
    if (batch.running) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------- Init ----------
  render();
  verifySession();
  scheduleIdleTimers();
  checkApi();
  setInterval(checkApi, 60000);
  setInterval(verifySession, 60000);
})();
