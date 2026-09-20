/* ============================================================
   FpEnhancer — Frontend logic
   Talks to the same-origin FastAPI backend:
     GET  /health  (falls back to GET /)  -> API status
     POST /enhance (multipart, field "file") -> image/png
   ============================================================ */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- Config ----------
  const ENHANCE_ENDPOINT = "/enhance";
  const HEALTH_ENDPOINTS = ["/health", "/"];
  const REQUEST_TIMEOUT_MS = 180000; // 3 min — CPU inference can be slow
  const MAX_FILE_MB = 25;
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp"];
  const ALLOWED_EXT = /\.(jpe?g|png|bmp)$/i;

  // ---------- Elements ----------
  const states = {
    upload: $("stateUpload"),
    preview: $("statePreview"),
    processing: $("stateProcessing"),
    result: $("stateResult"),
    error: $("stateError"),
  };

  const el = {
    apiStatus: $("apiStatus"),
    apiStatusText: $("apiStatusText"),
    dropzone: $("dropzone"),
    fileInput: $("fileInput"),
    chooseBtn: $("chooseBtn"),
    uploadError: $("uploadError"),
    previewImg: $("previewImg"),
    metaName: $("metaName"),
    metaSize: $("metaSize"),
    metaDims: $("metaDims"),
    metaType: $("metaType"),
    changeBtn: $("changeBtn"),
    removeBtn: $("removeBtn"),
    enhanceBtn: $("enhanceBtn"),
    previewError: $("previewError"),
    resultOriginal: $("resultOriginal"),
    resultEnhanced: $("resultEnhanced"),
    resultMeta: $("resultMeta"),
    downloadEnhanced: $("downloadEnhanced"),
    downloadOriginal: $("downloadOriginal"),
    anotherBtn: $("anotherBtn"),
    retryBtn: $("retryBtn"),
    errorNewBtn: $("errorNewBtn"),
    errorDetail: $("errorDetail"),
    compare: $("compare"),
    compareBefore: $("compareBefore"),
    compareAfter: $("compareAfter"),
    compareBeforeWrap: $("compareBeforeWrap"),
    compareHandle: $("compareHandle"),
    compareRange: $("compareRange"),
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
  };

  // ---------- App state ----------
  const app = {
    file: null,
    originalUrl: null,
    enhancedUrl: null,
    originalDims: null,
    enhancedDims: null,
    busy: false,
  };

  // ---------- Helpers ----------
  function showState(name) {
    Object.entries(states).forEach(([key, node]) => {
      node.classList.toggle("state--active", key === name);
    });
    if (name !== "upload") hide(el.uploadError);
    if (name !== "preview") hide(el.previewError);
  }

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

  // ---------- File selection ----------
  async function handleFile(file) {
    const err = validateFile(file);
    if (err) {
      showState("upload");
      show(el.uploadError, err);
      return;
    }

    clearAll(false);
    app.file = file;
    app.originalUrl = URL.createObjectURL(file);

    try {
      app.originalDims = await loadImageDims(app.originalUrl);
    } catch (_) {
      revoke(app.originalUrl);
      app.file = null; app.originalUrl = null;
      showState("upload");
      show(el.uploadError, "This file could not be read as an image. Please choose a valid JPG, PNG or BMP.");
      return;
    }

    el.previewImg.src = app.originalUrl;
    el.metaName.textContent = file.name || "image";
    el.metaSize.textContent = formatBytes(file.size);
    el.metaDims.textContent = `${app.originalDims.w} × ${app.originalDims.h} px`;
    el.metaType.textContent = (file.type || file.name.split(".").pop() || "image").replace("image/", "").toUpperCase();
    showState("preview");
  }

  function clearAll(goToUpload = true) {
    revoke(app.originalUrl);
    revoke(app.enhancedUrl);
    app.file = null;
    app.originalUrl = null;
    app.enhancedUrl = null;
    app.originalDims = null;
    app.enhancedDims = null;
    el.previewImg.removeAttribute("src");
    el.resultOriginal.removeAttribute("src");
    el.resultEnhanced.removeAttribute("src");
    el.compareBefore.removeAttribute("src");
    el.compareAfter.removeAttribute("src");
    el.fileInput.value = "";
    el.errorDetail.textContent = "";
    if (goToUpload) showState("upload");
  }

  // ---------- Enhance (REAL API CALL) ----------
  async function enhance() {
    if (app.busy) return;
    const err = validateFile(app.file);
    if (err) { show(el.previewError, err); return; }

    app.busy = true;
    el.enhanceBtn.disabled = true;
    showState("processing");

    const formData = new FormData();
    formData.append("file", app.file);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      // NOTE: do NOT set Content-Type — the browser sets the multipart boundary.
      const response = await fetch(ENHANCE_ENDPOINT, {
        method: "POST",
        body: formData,
        signal: ctrl.signal,
      });

      if (!response.ok) {
        throw await httpError(response);
      }

      const blob = await response.blob();

      if (!blob || blob.size === 0) {
        throw new AppError("The server returned an empty response.");
      }
      if (blob.type && !blob.type.startsWith("image/")) {
        throw new AppError("The server returned an unexpected response instead of an image.");
      }

      const enhancedUrl = URL.createObjectURL(blob);
      let dims;
      try {
        dims = await loadImageDims(enhancedUrl);
      } catch (_) {
        revoke(enhancedUrl);
        throw new AppError("The returned image could not be displayed.");
      }

      revoke(app.enhancedUrl);
      app.enhancedUrl = enhancedUrl;
      app.enhancedDims = dims;
      renderResult(blob);
    } catch (e) {
      renderError(e);
    } finally {
      clearTimeout(timer);
      app.busy = false;
      el.enhanceBtn.disabled = false;
    }
  }

  class AppError extends Error {
    constructor(message) { super(message); this.name = "AppError"; }
  }

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

    if (response.status === 400) return new AppError(detail || "The uploaded file was rejected as an invalid image.");
    if (response.status === 413) return new AppError("The image is too large for the server to accept.");
    if (response.status === 415 || response.status === 422) return new AppError(detail || "The server could not accept this file format.");
    if (response.status === 429) return new AppError("Too many requests. Please wait a moment and try again.");
    if (response.status === 502 || response.status === 503 || response.status === 504) return new AppError("The processing server is temporarily unavailable. Please try again shortly.");
    if (response.status >= 500) return new AppError("The server encountered an error while enhancing the image.");
    return new AppError(detail || `Request failed (HTTP ${response.status}).`);
  }

  function friendlyMessage(e) {
    if (e && e.name === "AbortError") return "The request timed out. The server may be busy — please try again.";
    if (e instanceof AppError) return e.message;
    if (e instanceof TypeError) return "Network error. Please check your connection and make sure the API is reachable.";
    return "";
  }

  function renderError(e) {
    el.errorDetail.textContent = friendlyMessage(e);
    showState("error");
    checkApi();
  }

  // ---------- Result rendering ----------
  function renderResult(blob) {
    el.resultOriginal.src = app.originalUrl;
    el.resultEnhanced.src = app.enhancedUrl;
    el.compareBefore.src = app.originalUrl;
    el.compareAfter.src = app.enhancedUrl;

    el.downloadEnhanced.href = app.enhancedUrl;
    el.downloadEnhanced.setAttribute("download", "enhanced_fingerprint.png");

    el.downloadOriginal.href = app.originalUrl;
    el.downloadOriginal.setAttribute("download", app.file?.name || "original_fingerprint.png");

    const o = app.originalDims, n = app.enhancedDims;
    el.resultMeta.innerHTML = "";
    const chips = [
      ["Original", `${o.w} × ${o.h} px • ${formatBytes(app.file.size)}`],
      ["Enhanced", `${n.w} × ${n.h} px • ${formatBytes(blob.size)}`],
      ["Format", (blob.type || "image/png").replace("image/", "").toUpperCase()],
    ];
    for (const [k, v] of chips) {
      const span = document.createElement("span");
      span.className = "chip";
      span.innerHTML = `<strong>${k}:</strong> ${v}`;
      el.resultMeta.appendChild(span);
    }

    // Compare slider aspect ratio follows the enhanced image
    el.compare.style.aspectRatio = `${n.w} / ${n.h}`;
    setCompare(50);
    setView("side");
    showState("result");
    states.result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- View toggle ----------
  function setView(view) {
    document.querySelectorAll(".seg__btn").forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle("seg__btn--active", active);
      b.setAttribute("aria-selected", String(active));
    });
    $("viewSide").classList.toggle("result__view--active", view === "side");
    $("viewCompare").classList.toggle("result__view--active", view === "compare");
    if (view === "compare") requestAnimationFrame(syncCompareWidth);
  }

  // ---------- Before/After slider ----------
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
  el.compare.addEventListener("pointerleave", () => { if (!el.compare.hasPointerCapture) dragging = false; });
  el.compareRange.addEventListener("input", (e) => setCompare(Number(e.target.value)));
  window.addEventListener("resize", () => { if ($("viewCompare").classList.contains("result__view--active")) syncCompareWidth(); });

  // ---------- Lightbox (zoom + fullscreen) ----------
  const lb = { scale: 1, min: 0.2, max: 12, x: 0, y: 0, natural: { w: 0, h: 0 }, drag: null, pinch: null };

  function openLightbox(kind) {
    const url = kind === "enhanced" ? app.enhancedUrl : app.originalUrl;
    if (!url) return;
    el.lightboxTitle.textContent = kind === "enhanced" ? "ENHANCED" : "ORIGINAL";
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
    document.body.style.overflow = "";
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
    if (!el.lightbox.classList.contains("lightbox--open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "+" || e.key === "=") zoomAt(1.25);
    if (e.key === "-") zoomAt(1 / 1.25);
    if (e.key === "0") fitToStage();
  });

  document.querySelectorAll("[data-zoom]").forEach((b) => b.addEventListener("click", () => openLightbox(b.dataset.zoom)));
  document.querySelectorAll("[data-full]").forEach((b) => b.addEventListener("click", async () => {
    openLightbox(b.dataset.full);
    try { await el.lightbox.requestFullscreen?.(); } catch (_) {}
    setTimeout(fitToStage, 150);
  }));
  el.resultOriginal.addEventListener("click", () => openLightbox("original"));
  el.resultEnhanced.addEventListener("click", () => openLightbox("enhanced"));

  // ---------- Dropzone events ----------
  const openPicker = () => el.fileInput.click();
  el.chooseBtn.addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });
  el.dropzone.addEventListener("click", (e) => { if (e.target === el.chooseBtn || el.chooseBtn.contains(e.target)) return; openPicker(); });
  el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
  el.fileInput.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) handleFile(f); });

  ["dragenter", "dragover"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); el.dropzone.classList.add("dropzone--over"); })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); if (evt === "dragleave" && el.dropzone.contains(e.relatedTarget)) return; el.dropzone.classList.remove("dropzone--over"); })
  );
  el.dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    el.dropzone.classList.remove("dropzone--over");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  // Allow dropping anywhere on the page while in upload/preview state
  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (app.busy) return;
    if (el.dropzone.contains(e.target)) return; // already handled
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  // Paste image from clipboard
  window.addEventListener("paste", (e) => {
    if (app.busy) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      const f = item.getAsFile();
      if (f) handleFile(new File([f], f.name || "pasted_fingerprint.png", { type: f.type }));
    }
  });

  // ---------- Button wiring ----------
  el.changeBtn.addEventListener("click", openPicker);
  el.removeBtn.addEventListener("click", () => clearAll(true));
  el.enhanceBtn.addEventListener("click", enhance);
  el.anotherBtn.addEventListener("click", () => clearAll(true));
  el.retryBtn.addEventListener("click", () => { if (app.file) enhance(); else showState("upload"); });
  el.errorNewBtn.addEventListener("click", () => clearAll(true));
  document.querySelectorAll(".seg__btn").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  // ---------- Init ----------
  checkApi();
  setInterval(checkApi, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkApi(); });
})();
