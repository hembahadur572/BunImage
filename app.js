// Bun Image Tools — client logic (vanilla ES module, no dependencies)

// ── State ──
const state = {
  id: null,
  name: "",
  width: 0,
  height: 0,
  size: 0,
  type: "",
  format: "",
  blob: null,
  previewTimer: null,
  aspectLocked: true,
  mode: "compressor",
  capabilities: { jpeg: true, png: true, webp: true, avif: false, heic: false },
};

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif", "image/heic"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ── DOM refs ──
const $ = (id) => document.getElementById(id);
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const localPreview = $("local-preview");
const uploadBarWrap = $("upload-bar-wrap");
const uploadBar = $("upload-bar");
const compressBar = $("compress-bar");
const cmp = $("cmp-container");
const cmpOrig = $("cmp-orig");
const cmpComp = $("cmp-comp");
const cmpOverlay = $("cmp-overlay");
const cmpHandle = $("cmp-handle");
const cmpCompLabel = $("cmp-comp-label");
const liveLabel = $("live-label");
const liveDot = $("live-dot");
const modeTitle = $("mode-title");

// ── Toasts ──
const toasts = $("toasts");
function toast(msg, kind = "info", ms = 2500) {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function setStatus(msg, isError) {
  const el = $("status");
  el.innerHTML = msg;
  el.className = "status" + (isError ? " error" : "");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

// ── Capabilities ──
fetch("/api/capabilities")
  .then((r) => r.json())
  .then((caps) => {
    state.capabilities = caps;
    ["c-avif-chip", "f-avif-chip"].forEach((id) => {
      const chip = $(id);
      if (!chip) return;
      if (!caps.avif) {
        chip.classList.add("disabled");
        chip.setAttribute("aria-disabled", "true");
        chip.title = "AVIF encoding is not supported on this platform";
      }
    });
  })
  .catch(() => {});

// ── Mode switching ──
function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-tab").forEach((t) => {
    const on = t.getAttribute("data-mode") === mode;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".mode-panel").forEach((p) => {
    p.classList.toggle("active", p.id === "panel-" + mode);
  });
  modeTitle.textContent = mode === "compressor" ? "Compressor" : "Format Changer";
  liveLabel.textContent = mode === "compressor" ? "Live Preview" : "";
  liveDot.style.display = mode === "compressor" ? "" : "none";
  if (state.id) schedulePreview();
}

// ── Upload ──
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) handleFile(f);
});

// ── Paste ──
document.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        handlePaste(file);
        return;
      }
    }
  }
});

// ── Keyboard shortcuts ──
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    if (state.blob) { e.preventDefault(); download(); }
    return;
  }
  if (e.key === "Escape" && state.id) reset();
});

// ── Comparison slider ──
let dragging = false;
function moveSplit(clientX) {
  const rect = cmp.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  cmpOverlay.style.width = pct * 100 + "%";
  cmpHandle.style.left = pct * 100 + "%";
  cmpHandle.setAttribute("aria-valuenow", Math.round(pct * 100));
}
cmp.addEventListener("pointerdown", (e) => {
  if (e.target === cmpHandle) dragging = true;
  else { dragging = true; moveSplit(e.clientX); }
  cmp.setPointerCapture(e.pointerId);
});
cmp.addEventListener("pointermove", (e) => { if (dragging) moveSplit(e.clientX); });
cmp.addEventListener("pointerup", () => { dragging = false; });
cmp.addEventListener("pointercancel", () => { dragging = false; });
cmpHandle.addEventListener("keydown", (e) => {
  const cur = parseFloat(cmpHandle.getAttribute("aria-valuenow")) || 50;
  if (e.key === "ArrowLeft") { e.preventDefault(); moveSplit(cmp.getBoundingClientRect().left + ((cur - 5) / 100) * cmp.getBoundingClientRect().width); }
  if (e.key === "ArrowRight") { e.preventDefault(); moveSplit(cmp.getBoundingClientRect().left + ((cur + 5) / 100) * cmp.getBoundingClientRect().width); }
});

// ── Chip groups ──
function setupChipGroup(groupId, onChange) {
  const chips = document.querySelectorAll("#" + groupId + " .chip");
  chips.forEach((c) => {
    c.addEventListener("click", () => {
      if (c.classList.contains("disabled")) return;
      chips.forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      onChange(c.getAttribute("data-val"));
    });
  });
}
function activeChipVal(groupId) {
  const el = document.querySelector("#" + groupId + " .chip.active");
  return el ? el.getAttribute("data-val") : "";
}

setupChipGroup("c-rotate-group", () => schedulePreview());
setupChipGroup("c-flip-group", () => schedulePreview());
setupChipGroup("c-format-group", () => { onCompressorFormatChange(); schedulePreview(); });
setupChipGroup("f-format-group", () => onConverterFormatChange());

// ── Compressor control bindings ──
const cQuality = $("c-quality");
cQuality.addEventListener("input", (e) => { $("c-quality-label").textContent = e.target.value; schedulePreview(); });

$("c-filter").addEventListener("change", (e) => {
  const opt = e.target.options[e.target.selectedIndex];
  $("c-filter-label").textContent = opt.value ? opt.value : "lanczos3 (default)";
  schedulePreview();
});

const crw = $("c-resize-w");
const crh = $("c-resize-h");
crw.addEventListener("input", () => { if (state.aspectLocked && state.width) autoLockH(); schedulePreview(); });
crh.addEventListener("input", () => schedulePreview());
$("c-fit").addEventListener("change", schedulePreview);
$("c-no-enlarge").addEventListener("change", schedulePreview);

$("c-lock-btn").addEventListener("click", function () {
  state.aspectLocked = !state.aspectLocked;
  this.classList.toggle("locked");
  this.innerHTML = state.aspectLocked ? "&#x1F517;" : "&#x1F513;";
  this.title = state.aspectLocked ? "Aspect ratio locked" : "Aspect ratio unlocked";
});

function autoLockH() {
  const w = parseInt(crw.value);
  if (!w || w <= 0) return;
  crh.value = Math.round((state.height / state.width) * w);
}

// Color controls
const cBrightness = $("c-brightness");
const cSaturation = $("c-saturation");
cBrightness.addEventListener("input", (e) => { $("c-brightness-label").textContent = parseFloat(e.target.value).toFixed(2); schedulePreview(); });
cSaturation.addEventListener("input", (e) => { $("c-saturation-label").textContent = parseFloat(e.target.value).toFixed(2); schedulePreview(); });
$("c-greyscale").addEventListener("change", (e) => {
  cSaturation.disabled = e.target.checked;
  schedulePreview();
});

// Advanced encode options
$("c-lossless").addEventListener("change", schedulePreview);
$("c-progressive").addEventListener("change", schedulePreview);
$("c-compression").addEventListener("input", (e) => { $("c-compression-label").textContent = e.target.value; schedulePreview(); });
$("c-palette").addEventListener("change", () => { updatePaletteSubcontrols(); schedulePreview(); });
$("c-colors").addEventListener("input", (e) => { $("c-colors-label").textContent = e.target.value; schedulePreview(); });
$("c-dither").addEventListener("change", schedulePreview);

function updatePaletteSubcontrols() {
  const on = $("c-palette").checked;
  $("c-colors-group").style.display = on ? "block" : "none";
  $("c-dither-row").style.display = on ? "flex" : "none";
}

function onCompressorFormatChange() {
  const fmt = activeChipVal("c-format-group");
  $("c-format-label").textContent = fmt.toUpperCase();
  $("c-quality-group").style.display = fmt === "png" ? "none" : "block";
  $("c-lossless-row").style.display = fmt === "webp" ? "flex" : "none";
  $("c-progressive-row").style.display = fmt === "jpeg" ? "flex" : "none";
  $("c-compression-group").style.display = fmt === "png" ? "block" : "none";
  $("c-palette-wrap").style.display = fmt === "png" ? "block" : "none";
  if (fmt === "png") updatePaletteSubcontrols();
}

function onConverterFormatChange() {
  const fmt = activeChipVal("f-format-group");
  $("f-quality-group").style.display = fmt === "png" ? "none" : "block";
}

// ── Presets ──
const PRESETS = {
  web: { format: "webp", quality: 75, w: "", h: "", lossless: false, palette: false },
  social: { format: "jpeg", quality: 80, w: 1200, h: "", progressive: true },
  thumb: { format: "webp", quality: 70, w: 400, h: "" },
  lossless: { format: "webp", quality: 90, w: "", h: "", lossless: true },
  screenshot: { format: "png", palette: true, colors: 256, w: "", h: "" },
};

function setChip(groupId, val) {
  const chips = document.querySelectorAll("#" + groupId + " .chip");
  chips.forEach((c) => c.classList.toggle("active", c.getAttribute("data-val") === val));
}

document.querySelectorAll(".preset").forEach((p) => {
  p.addEventListener("click", () => {
    const preset = PRESETS[p.getAttribute("data-preset")];
    if (!preset) return;
    setChip("c-format-group", preset.format);
    onCompressorFormatChange();
    if (preset.quality != null) { cQuality.value = preset.quality; $("c-quality-label").textContent = preset.quality; }
    crw.value = preset.w != null ? preset.w : "";
    crh.value = preset.h != null ? preset.h : "";
    $("c-no-enlarge").checked = true;
    $("c-lossless").checked = !!preset.lossless;
    $("c-progressive").checked = !!preset.progressive;
    $("c-palette").checked = !!preset.palette;
    if (preset.colors) { $("c-colors").value = preset.colors; $("c-colors-label").textContent = preset.colors; }
    updatePaletteSubcontrols();
    toast("Preset applied: " + p.textContent, "info", 1500);
    schedulePreview();
  });
});

// ── Upload handler ──
function handleFile(file) {
  if (!ALLOWED_TYPES.includes(file.type) && !file.type.startsWith("image/")) {
    toast("Unsupported file type: " + (file.type || "unknown"), "error");
    setStatus("Unsupported file type: " + (file.type || "unknown"), true);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    const msg = "File too large — max 50 MB (got " + formatSize(file.size) + ")";
    toast(msg, "error");
    setStatus(msg, true);
    return;
  }
  showLocalPreview(file);
  setStatus("Uploading…", false);
  uploadBarWrap.style.display = "block";
  uploadBar.style.width = "0%";

  const form = new FormData();
  form.append("file", file);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload", true);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) uploadBar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
  };
  xhr.onload = () => {
    uploadBarWrap.style.display = "none";
    if (xhr.status !== 200) {
      let msg = "Upload failed (" + xhr.status + ")";
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      toast(msg, "error");
      setStatus(msg, true);
      return;
    }
    try { afterUpload(JSON.parse(xhr.responseText)); }
    catch (_) { setStatus("Invalid server response", true); }
  };
  xhr.onerror = () => { uploadBarWrap.style.display = "none"; setStatus("Network error during upload", true); };
  xhr.send(form);
}

function handlePaste(file) {
  toast("Image pasted — processing…", "info", 1500);
  handleFile(file);
}

function showLocalPreview(file) {
  const url = URL.createObjectURL(file);
  localPreview.classList.remove("ready");
  localPreview.classList.add("loading");
  localPreview.src = url;
  localPreview.style.display = "block";
  localPreview.onload = () => {
    localPreview.classList.add("ready");
    localPreview.classList.remove("loading");
    URL.revokeObjectURL(url);
  };
  dropZone.querySelector(".icon").style.display = "none";
}

function afterUpload(data) {
  state.id = data.id;
  state.name = data.name;
  state.width = data.width;
  state.height = data.height;
  state.size = data.size;
  state.type = data.type;
  state.format = data.format || "";

  $("info-name").textContent = data.name;
  $("info-type").textContent = (data.format || data.type || "?").replace("image/", "").toUpperCase();
  $("info-dims").textContent = data.width + " × " + data.height;
  $("info-size").textContent = formatSize(data.size);
  $("img-info").style.display = "block";

  dropZone.classList.add("has-image");
  dropZone.querySelector(".hint").textContent = "Click or drop to change";
  $("controls-card").style.display = "block";
  $("results-section").style.display = "none";
  setStatus("", false);

  // Show the ThumbHash placeholder immediately while the real image loads.
  if (data.placeholder) {
    localPreview.src = data.placeholder;
    localPreview.classList.add("ready");
    localPreview.classList.remove("loading");
  }

  onCompressorFormatChange();
  schedulePreview();
}

// ── Compression / Convert ──
function schedulePreview() {
  if (!state.id || state.mode !== "compressor") return;
  if (state.previewTimer) clearTimeout(state.previewTimer);
  liveDot.className = "dot busy";
  state.previewTimer = setTimeout(doCompress, 400);
}

function compressorParams() {
  const p = new URLSearchParams();
  p.set("quality", cQuality.value);
  p.set("format", activeChipVal("c-format-group"));
  if (crw.value) p.set("width", crw.value);
  if (crh.value) p.set("height", crh.value);
  p.set("fit", $("c-fit").value);
  const filter = $("c-filter").value;
  if (filter) p.set("filter", filter);
  if ($("c-no-enlarge").checked) p.set("withoutEnlargement", "true");
  const rotate = activeChipVal("c-rotate-group");
  if (rotate && rotate !== "0") p.set("rotate", rotate);
  const flip = activeChipVal("c-flip-group");
  if (flip === "flip") p.set("flip", "true");
  else if (flip === "flop") p.set("flop", "true");
  else if (flip === "both") { p.set("flip", "true"); p.set("flop", "true"); }
  if (parseFloat(cBrightness.value) !== 1) p.set("brightness", cBrightness.value);
  if ($("c-greyscale").checked) p.set("greyscale", "true");
  else if (parseFloat(cSaturation.value) !== 1) p.set("saturation", cSaturation.value);
  if ($("c-lossless").checked) p.set("lossless", "true");
  if ($("c-progressive").checked) p.set("progressive", "true");
  p.set("compressionLevel", $("c-compression").value);
  if ($("c-palette").checked) {
    p.set("palette", "true");
    p.set("colors", $("c-colors").value);
    if ($("c-dither").checked) p.set("dither", "true");
  }
  return p;
}

function applyResult(result, label) {
  if (state.blob) URL.revokeObjectURL(state.blobUrl);
  state.blob = result.blob;
  state.blobUrl = URL.createObjectURL(result.blob);

  cmpOrig.src = "/api/original/" + state.id;
  cmpComp.src = state.blobUrl;
  cmpCompLabel.textContent = label;
  cmpOrig.onerror = function () { this.alt = "Original failed to load"; };
  cmpComp.onerror = function () { this.alt = "Processed failed to load"; };

  $("results-section").style.display = "block";
  cmpOverlay.style.width = "50%";
  cmpHandle.style.left = "50%";
  cmpHandle.setAttribute("aria-valuenow", "50");

  $("res-original").textContent = formatSize(result.origSize);
  const compEl = $("res-compressed");
  compEl.textContent = formatSize(result.compSize);
  compEl.className = "stat-value " + (result.compSize < result.origSize ? "good" : "bad");

  const savingsNum = parseFloat(result.ratio);
  const svEl = $("res-savings");
  svEl.textContent = savingsNum > 0 ? "-" + result.ratio + "%" : "+" + Math.abs(savingsNum).toFixed(1) + "%";
  svEl.className = "stat-value " + (savingsNum > 0 ? "good" : (savingsNum < 0 ? "bad" : "info"));

  $("res-dims").textContent = (result.cw && result.ch) ? result.cw + " × " + result.ch : state.width + " × " + state.height;
  $("res-format").textContent = (result.format || "").toUpperCase();
  $("res-ratio").textContent = (result.compSize / result.origSize).toFixed(2) + "×";
}

function fetchProcessed(params) {
  return fetch("/api/compress/" + state.id + "?" + params.toString()).then((res) => {
    if (!res.ok) {
      return res.json().then((e) => { throw new Error(e.error || "Request failed"); });
    }
    return res.blob().then((blob) => ({
      blob,
      origSize: parseInt(res.headers.get("X-Original-Size")),
      compSize: parseInt(res.headers.get("X-Compressed-Size")),
      ratio: res.headers.get("X-Compression-Ratio") || "0",
      cw: res.headers.get("X-Compressed-Width"),
      ch: res.headers.get("X-Compressed-Height"),
      format: res.headers.get("X-Output-Format") || "",
    }));
  });
}

function doCompress() {
  state.previewTimer = null;
  if (!state.id) return;
  compressBar.style.display = "block";
  const fmt = activeChipVal("c-format-group");
  fetchProcessed(compressorParams())
    .then((result) => {
      applyResult(result, "Compressed · " + fmt.toUpperCase());
      liveDot.className = "dot";
      compressBar.style.display = "none";
      setStatus("", false);
    })
    .catch((e) => {
      liveDot.className = "dot";
      compressBar.style.display = "none";
      setStatus(e.message, true);
      toast(e.message, "error");
    });
}

// ── Format Changer: Convert + Download ──
function doConvert() {
  if (!state.id) return;
  compressBar.style.display = "block";
  setStatus("Converting…", false);

  const format = activeChipVal("f-format-group");
  const p = new URLSearchParams();
  p.set("quality", $("f-quality").value);
  p.set("format", format);
  if ($("f-resize-w").value) p.set("width", $("f-resize-w").value);
  if ($("f-resize-h").value) p.set("height", $("f-resize-h").value);
  p.set("fit", $("f-fit").value);
  if ($("f-no-enlarge").checked) p.set("withoutEnlargement", "true");

  fetchProcessed(p)
    .then((result) => {
      applyResult(result, format.toUpperCase());
      compressBar.style.display = "none";
      setStatus("", false);
      triggerDownload(state.blob, state.name.replace(/\.[^.]+$/, "") + "." + format);
      toast("Converted to " + format.toUpperCase(), "success");
    })
    .catch((e) => {
      compressBar.style.display = "none";
      setStatus(e.message, true);
      toast(e.message, "error");
    });
}

// ── Download ──
function currentFormat() {
  return state.mode === "format" ? activeChipVal("f-format-group") : activeChipVal("c-format-group");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function download() {
  if (!state.blob) return;
  triggerDownload(state.blob, state.name.replace(/\.[^.]+$/, "") + "." + currentFormat());
}

// ── Reset ──
function reset() {
  if (state.blob) { URL.revokeObjectURL(state.blob); state.blob = null; }
  if (state.previewTimer) { clearTimeout(state.previewTimer); state.previewTimer = null; }
  Object.assign(state, { id: null, name: "", width: 0, height: 0, size: 0, type: "", format: "" });

  compressBar.style.display = "none";
  $("results-section").style.display = "none";
  $("controls-card").style.display = "none";
  $("img-info").style.display = "none";
  localPreview.style.display = "none";
  localPreview.src = "";
  localPreview.classList.remove("loading", "ready");
  dropZone.classList.remove("has-image");
  dropZone.querySelector(".icon").style.display = "";
  dropZone.querySelector(".hint").innerHTML = 'Drop an image here or <label>click to browse</label>';
  fileInput.value = "";

  // Full control reset
  cQuality.value = 80; $("c-quality-label").textContent = "80";
  cBrightness.value = 1; $("c-brightness-label").textContent = "1.00";
  cSaturation.value = 1; $("c-saturation-label").textContent = "1.00";
  cSaturation.disabled = false;
  $("c-greyscale").checked = false;
  $("c-lossless").checked = false;
  $("c-progressive").checked = false;
  $("c-palette").checked = false;
  $("c-dither").checked = false;
  $("c-compression").value = 6; $("c-compression-label").textContent = "6";
  $("c-colors").value = 256; $("c-colors-label").textContent = "256";
  crw.value = ""; crh.value = "";
  $("f-resize-w").value = ""; $("f-resize-h").value = "";
  $("c-no-enlarge").checked = false;
  $("f-no-enlarge").checked = false;
  setChip("c-rotate-group", "0");
  setChip("c-flip-group", "none");
  setChip("c-format-group", "jpeg");
  setChip("f-format-group", "jpeg");
  $("c-fit").value = "inside";
  $("f-fit").value = "inside";
  onCompressorFormatChange();
  onConverterFormatChange();
  setStatus("", false);
}

// ── Expose globals used by inline handlers in index.html ──
window.switchMode = switchMode;
window.doConvert = doConvert;
window.download = download;
window.reset = reset;
