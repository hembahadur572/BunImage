// Bun Image Compress Server
// Uses Bun's native Image API for fast image compression

const store = new Map();
let nextId = 1;

// ── In-memory store with TTL ────────────────────────────────────────────────

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // check every 5 min

function storeSet(id, entry) {
  entry._expires = Date.now() + TTL_MS;
  store.set(id, entry);
}

// Periodic cleanup so idle images don't leak
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry._expires < now) store.delete(id);
  }
}, CLEANUP_INTERVAL).unref();

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_PIXELS = 4096 * 4096; // ~16 MP, prevents memory DoS
const VALID_FORMATS = new Set(["jpeg", "png", "webp"]);
const VALID_FITS = new Set(["fill", "inside"]);
const VALID_FILTERS = new Set([
  "lanczos3", "lanczos2", "mitchell", "cubic",
  "mks2013", "mks2021", "bilinear", "linear", "box", "nearest",
]);
const VALID_ROTATIONS = new Set([90, 180, 270]);

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

// Strip extension from a filename
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
  const form = await req.formData();
  const file = form.get("file");
  if (!file) return error("No file uploaded");

  const buffer = new Uint8Array(await file.arrayBuffer());
  let img;
  try {
    img = new Bun.Image(buffer, { autoOrient: true, maxPixels: MAX_PIXELS });
  } catch (e) {
    return error("Unsupported image format: " + e.message);
  }

  const meta = await img.metadata();

  const id = "img_" + nextId++;
  storeSet(id, {
    buffer,
    mime: file.type || "image/png",
    name: file.name,
    width: meta.width,
    height: meta.height,
    size: buffer.length,
  });

  return json({
    id,
    name: file.name,
    width: meta.width,
    height: meta.height,
    size: buffer.length,
    type: file.type,
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
  const saturation = parseFloatSafe(params.get("saturation"), 1);

  // Validate
  if (!VALID_FORMATS.has(format)) return error("Unsupported format: " + format);
  if (!VALID_FITS.has(fit)) return error("fit must be 'fill' or 'inside'");
  if (filter && !VALID_FILTERS.has(filter)) return error("Invalid filter: " + filter);
  if (rotate && !VALID_ROTATIONS.has(rotate)) return error("rotate must be 90, 180, or 270");

  // Decode
  let img;
  try {
    img = new Bun.Image(stored.buffer, { autoOrient: true, maxPixels: MAX_PIXELS });
  } catch (e) {
    return error("Decode error: " + e.message);
  }

  // ── Transform pipeline ──

  // 1. Rotate (multiples of 90)
  if (rotate) img = img.rotate(rotate);

  // 2. Flip / flop
  if (flipV) img = img.flip();
  if (flipH) img = img.flop();

  // 3. Modulate (brightness / saturation)
  if (brightness !== 1 || saturation !== 1) {
    img = img.modulate({ brightness, saturation });
  }

  // 4. Resize
  const doResize = (outW > 0 || outH > 0);
  if (doResize) {
    const width = outW > 0 ? outW : stored.width;
    const height = outH > 0 ? outH : stored.height;
    const resizeOpts = { fit };
    if (filter) resizeOpts.filter = filter;
    if (noEnlarge) resizeOpts.withoutEnlargement = true;
    img = img.resize(width, height, resizeOpts);
  }

  // 5. Encode
  let out;
  let mime;
  try {
    switch (format) {
      case "jpeg":
        out = await img.jpeg({ quality }).bytes();
        mime = "image/jpeg";
        break;
      case "png":
        out = await img.png().bytes();
        mime = "image/png";
        break;
      case "webp":
        out = await img.webp({ quality }).bytes();
        mime = "image/webp";
        break;
    }
  } catch (e) {
    return error("Encode error: " + e.message);
  }

  const ratio = ((1 - out.length / stored.size) * 100).toFixed(1);

  // Actual output dimensions (re-read from encoded bytes if resized)
  let compW = stored.width;
  let compH = stored.height;
  if (doResize || rotate) {
    try {
      const reMeta = await new Bun.Image(out).metadata();
      compW = reMeta.width;
      compH = reMeta.height;
    } catch (_) {}
  }

  // Preserve original filename with new extension
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
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="' + downloadName + '"',
    },
  });
}

// ── Server ──

const PORT = parseInt(Bun.env.PORT || "3000");
const scriptURL = import.meta.url;
const scriptPath = scriptURL.startsWith("file://") ? scriptURL.slice(7) : scriptURL;
const dir = scriptPath.substring(0, scriptPath.lastIndexOf("/") + 1);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // POST /api/upload
    if (url.pathname === "/api/upload" && method === "POST") {
      return await handleUpload(req);
    }

    // GET /api/compress/:id
    const compressMatch = url.pathname.match(/^\/api\/compress\/(.+)$/);
    if (compressMatch && method === "GET") {
      return await handleCompress(compressMatch[1], url.searchParams);
    }

    // GET /api/info/:id
    const infoMatch = url.pathname.match(/^\/api\/info\/(.+)$/);
    if (infoMatch && method === "GET") {
      const stored = store.get(infoMatch[1]);
      if (!stored) return error("Image not found", 404);
      return json({
        id: infoMatch[1],
        name: stored.name,
        width: stored.width,
        height: stored.height,
        size: stored.size,
        mime: stored.mime,
      });
    }

    // GET /api/original/:id — serve the original image (for preview comparison)
    const origMatch = url.pathname.match(/^\/api\/original\/(.+)$/);
    if (origMatch && method === "GET") {
      const stored = store.get(origMatch[1]);
      if (!stored) return error("Image not found", 404);
      return new Response(stored.buffer, {
        headers: {
          "Content-Type": stored.mime,
          "Cache-Control": "no-store",
        },
      });
    }

    // Serve static HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const htmlFile = Bun.file(dir + "index.html");
      return new Response(htmlFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("");
console.log("  Bun Image Compress running at http://localhost:" + PORT);
console.log("  Formats: JPEG, PNG, WebP | Fit: fill, inside");
console.log("  Filters: lanczos3, mitchell, nearest, box, bilinear, cubic, mks2013, mks2021");
console.log("  Transforms: rotate (90/180/270), flip, flop, modulate (brightness, saturation)");
console.log("  Stored images expire after 30 min");
console.log("");
