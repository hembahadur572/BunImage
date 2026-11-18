// Bun Image Tools Server
// Zero-dependency image compression/conversion using Bun's native Image API
// and Bun.serve() declarative routes with an HTML entry (bundled + HMR in dev).

import { unlinkSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import index from "./index.html";

// ── Persistent store ─────────────────────────────────────────────────────────

const store = new Map();
let nextId = 1;

const UPLOADS_DIR = join(import.meta.dir, "uploads");
const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // fallback check every 5 min

if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

function storeSet(id, entry) {
  entry._expires = Date.now() + TTL_MS;
  store.set(id, entry);
}

function saveToDisk(id, entry) {
  writeFileSync(join(UPLOADS_DIR, id + ".json"), JSON.stringify({
    name: entry.name,
    mime: entry.mime,
    format: entry.format || "",
    width: entry.width,
    height: entry.height,
    size: entry.size,
    placeholder: entry.placeholder || "",
    created: entry._expires - TTL_MS,
  }));
  writeFileSync(join(UPLOADS_DIR, id + ".bin"), Buffer.from(entry.buffer));
}

function deleteFromDisk(id) {
  try { unlinkSync(join(UPLOADS_DIR, id + ".json")); } catch (_) {}
  try { unlinkSync(join(UPLOADS_DIR, id + ".bin")); } catch (_) {}
}

function loadPersistentStore() {
  let maxId = 0;
  const now = Date.now();
  try {
    for (const file of readdirSync(UPLOADS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5); // strip ".json"
      const metaPath = join(UPLOADS_DIR, file);
      const binPath = join(UPLOADS_DIR, id + ".bin");
      if (!existsSync(binPath)) continue;

      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const created = meta.created || now;
        if (now - created > TTL_MS) {
          deleteFromDisk(id);
          continue;
        }
        const buffer = new Uint8Array(readFileSync(binPath));
        storeSet(id, {
          buffer,
          mime: meta.mime || "image/png",
          name: meta.name || "image.png",
          format: meta.format || "",
          width: meta.width || 0,
          height: meta.height || 0,
          size: meta.size || buffer.length,
          placeholder: meta.placeholder || "",
        });
        const numId = parseInt(id.replace("img_", ""));
        if (numId > maxId) maxId = numId;
      } catch (_) {
        // Corrupted entry — clean up
        deleteFromDisk(id);
      }
    }
  } catch (_) {}
  nextId = maxId + 1;
  console.log("  Loaded " + store.size + " images from disk (next ID: img_" + nextId + ")");
}

// ── Expiry cleanup ───────────────────────────────────────────────────────────

function cleanupExpired() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry._expires < now) {
      store.delete(id);
      deleteFromDisk(id);
    }
  }
}

// Prefer Bun.cron() (native scheduler) when available, fall back to setInterval.
try {
  if (typeof Bun.cron === "function") {
    const job = Bun.cron("*/5 * * * *", cleanupExpired);
    if (job && typeof job.unref === "function") job.unref();
  } else {
    throw new Error("no cron");
  }
} catch (_) {
  const timer = setInterval(cleanupExpired, CLEANUP_INTERVAL);
  if (typeof timer.unref === "function") timer.unref();
}

loadPersistentStore();

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_PIXELS = 4096 * 4096; // ~16 MP, prevents memory DoS
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB max upload
const VALID_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heic"]);
const VALID_FITS = new Set(["fill", "inside"]);
const VALID_FILTERS = new Set([
  "lanczos3", "lanczos2", "mitchell", "cubic",
  "mks2013", "mks2021", "bilinear", "linear", "box", "nearest",
]);
const VALID_ROTATIONS = new Set([90, 180, 270]);
const FORMAT_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

// 1×1 transparent PNG used to probe encoder availability at startup.
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64"
);

// ── Capabilities ─────────────────────────────────────────────────────────────

// HEIC/AVIF need OS codecs and are unavailable on Linux, so probe once at boot
// and let the UI disable unsupported output formats.
let CAPABILITIES = { jpeg: true, png: true, webp: true, avif: false, heic: false };

async function probeCapabilities() {
  const attempts = {
    jpeg: (img) => img.jpeg({ quality: 80 }),
    png: (img) => img.png(),
    webp: (img) => img.webp({ quality: 80 }),
    avif: (img) => img.avif({ quality: 60 }),
    heic: (img) => img.heic({ quality: 80 }),
  };
  const caps = {};
  for (const [name, fn] of Object.entries(attempts)) {
    try {
      await fn(new Bun.Image(PROBE_PNG)).bytes();
      caps[name] = true;
    } catch (_) {
      caps[name] = false;
    }
  }
  CAPABILITIES = caps;
  const on = Object.keys(caps).filter((k) => caps[k]);
  console.log("  Encoders available: " + on.join(", "));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

function stem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function parseIntSafe(val, fallback) {
  const n = parseInt(val);
  return isNaN(n) ? fallback : n;
}

function parseFloatSafe(val, fallback) {
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleUpload(req) {
  let form;
  try {
    form = await req.formData();
  } catch (_) {
    return error("Invalid upload payload");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return error("No file uploaded");

  // Enforce max upload size
  if (file.size > MAX_UPLOAD_BYTES) {
    return error("File too large — max " + (MAX_UPLOAD_BYTES / 1024 / 1024) + " MB");
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  let img;
  try {
    img = new Bun.Image(buffer, { autoOrient: true, maxPixels: MAX_PIXELS });
  } catch (e) {
    return error("Unsupported image format: " + e.message);
  }

  let meta;
  try {
    meta = await img.metadata();
  } catch (e) {
    return error("Could not read image: " + e.message);
  }

  // Low-quality placeholder (ThumbHash data URL) for progressive preview.
  let placeholder = "";
  try {
    placeholder = await new Bun.Image(buffer, { maxPixels: MAX_PIXELS }).placeholder();
  } catch (_) {}

  const id = "img_" + nextId++;
  const entry = {
    buffer,
    mime: file.type || "image/png",
    name: file.name || "image.png",
    format: meta.format || "",
    width: meta.width,
    height: meta.height,
    size: buffer.length,
    placeholder,
  };
  storeSet(id, entry);
  saveToDisk(id, entry); // persist to disk

  return json({
    id,
    name: entry.name,
    width: meta.width,
    height: meta.height,
    size: buffer.length,
    type: file.type,
    format: meta.format || "",
    placeholder,
  });
}

async function handleCompress(id, params) {
  const stored = store.get(id);
  if (!stored) return error("Image not found", 404);

  // Parse params with defaults
  const quality = clamp(parseIntSafe(params.get("quality"), 80), 1, 100);
  const format = params.get("format") ?? "jpeg";
  const outW = parseIntSafe(params.get("width"), 0);
  const outH = parseIntSafe(params.get("height"), 0);
  const fit = params.get("fit") ?? "inside";
  const filter = params.get("filter") ?? "";
  const noEnlarge = params.get("withoutEnlargement") === "true";
  const rotate = parseIntSafe(params.get("rotate"), 0);
  const flipV = params.get("flip") === "true";
  const flipH = params.get("flop") === "true";
  const brightness = parseFloatSafe(params.get("brightness"), 1);
  const greyscale = params.get("greyscale") === "true";
  const saturation = greyscale ? 0 : parseFloatSafe(params.get("saturation"), 1);

  // Advanced encode options
  const lossless = params.get("lossless") === "true";
  const progressive = params.get("progressive") === "true";
  const compressionLevel = clamp(parseIntSafe(params.get("compressionLevel"), 6), 0, 9);
  const palette = params.get("palette") === "true";
  const colors = clamp(parseIntSafe(params.get("colors"), 256), 2, 256);
  const dither = params.get("dither") === "true";

  if (!VALID_FORMATS.has(format)) return error("Unsupported format: " + format);
  if (!CAPABILITIES[format]) {
    return error(
      "Format '" + format + "' is not supported on this platform — try JPEG, PNG, or WebP",
      501
    );
  }
  if (!VALID_FITS.has(fit)) return error("fit must be 'fill' or 'inside'");
  if (filter && !VALID_FILTERS.has(filter)) return error("Invalid filter: " + filter);
  if (rotate && !VALID_ROTATIONS.has(rotate)) return error("rotate must be 90, 180, or 270");

  let img;
  try {
    img = new Bun.Image(stored.buffer, { autoOrient: true, maxPixels: MAX_PIXELS });
  } catch (e) {
    return error("Decode error: " + e.message);
  }

  // ── Transform pipeline ──
  if (rotate) img = img.rotate(rotate);
  if (flipV) img = img.flip();
  if (flipH) img = img.flop();
  if (brightness !== 1 || saturation !== 1) {
    img = img.modulate({ brightness, saturation });
  }

  const doResize = (outW > 0 || outH > 0);
  if (doResize) {
    const width = outW > 0 ? outW : stored.width;
    const height = outH > 0 ? outH : stored.height;
    const resizeOpts = { fit };
    if (filter) resizeOpts.filter = filter;
    if (noEnlarge) resizeOpts.withoutEnlargement = true;
    img = img.resize(width, height, resizeOpts);
  }

  let out;
  let mime;
  try {
    switch (format) {
      case "jpeg":
        out = await img.jpeg({ quality, progressive }).bytes();
        break;
      case "png": {
        // Only pass palette/dither when indexing; a plain PNG ignores them.
        const pngOpts = { compressionLevel };
        if (palette) {
          pngOpts.palette = true;
          pngOpts.colors = colors;
          pngOpts.dither = dither;
        }
        out = await img.png(pngOpts).bytes();
        break;
      }
      case "webp":
        out = await img.webp({ quality, lossless }).bytes();
        break;
      case "avif":
        out = await img.avif({ quality }).bytes();
        break;
      case "heic":
        out = await img.heic({ quality }).bytes();
        break;
    }
    mime = FORMAT_MIME[format];
  } catch (e) {
    if (e && e.code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
      return error("Format '" + format + "' is not supported on this platform", 501);
    }
    return error("Encode error: " + e.message);
  }

  const ratio = ((1 - out.length / stored.size) * 100).toFixed(1);

  let compW = stored.width;
  let compH = stored.height;
  if (doResize || rotate) {
    try {
      const reMeta = await new Bun.Image(out).metadata();
      compW = reMeta.width;
      compH = reMeta.height;
    } catch (_) {}
  }

  const downloadName = stem(stored.name) + "." + format;

  return new Response(out, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(out.length),
      "X-Original-Size": String(stored.size),
      "X-Compressed-Size": String(out.length),
      "X-Compression-Ratio": ratio + "%",
      "X-Compressed-Width": String(compW),
      "X-Compressed-Height": String(compH),
      "X-Output-Format": format,
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="' + downloadName + '"',
    },
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

const PORT = parseInt(Bun.env.PORT || "3000");
const DEVELOPMENT = Bun.env.NODE_ENV !== "production";

await probeCapabilities();

export const server = Bun.serve({
  port: PORT,
  development: DEVELOPMENT,
  routes: {
    "/": index,

    "/api/capabilities": {
      GET: () => json(CAPABILITIES),
    },

    "/api/upload": {
      POST: handleUpload,
    },

    "/api/compress/:id": {
      GET: (req) => handleCompress(req.params.id, new URL(req.url).searchParams),
    },

    "/api/info/:id": {
      GET: (req) => {
        const stored = store.get(req.params.id);
        if (!stored) return error("Image not found", 404);
        return json({
          id: req.params.id,
          name: stored.name,
          width: stored.width,
          height: stored.height,
          size: stored.size,
          mime: stored.mime,
          format: stored.format || "",
        });
      },
    },

    "/api/placeholder/:id": {
      GET: (req) => {
        const stored = store.get(req.params.id);
        if (!stored) return error("Image not found", 404);
        return json({ placeholder: stored.placeholder || "" });
      },
    },

    "/api/original/:id": {
      GET: (req) => {
        const stored = store.get(req.params.id);
        if (!stored) return error("Image not found", 404);
        return new Response(stored.buffer, {
          headers: {
            "Content-Type": stored.mime,
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },

  fetch(req) {
    // CORS preflight + JSON 404 fallback for unmatched routes.
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    return error("Not Found", 404);
  },
});

console.log("");
console.log("  Bun Image Tools running at http://localhost:" + server.port);
console.log("  Encoders: JPEG, PNG, WebP" + (CAPABILITIES.avif ? ", AVIF" : "") + (CAPABILITIES.heic ? ", HEIC" : ""));
console.log("  Fit: fill, inside | Filters: lanczos3, mitchell, nearest, box, bilinear, cubic, mks2013, mks2021");
console.log("  Transforms: rotate (90/180/270), flip, flop, modulate (brightness, saturation, greyscale)");
console.log("  Storage: persistent on disk at " + UPLOADS_DIR);
console.log("  Images expire after 30 min | mode: " + (DEVELOPMENT ? "development" : "production"));
console.log("");
