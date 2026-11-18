// API tests for Bun Image Tools.
// Run with: bun test
//
// The server is imported dynamically with PORT=0 so Bun picks a free port;
// the app's own `server.port` is used to build request URLs.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { deflateSync } from "node:zlib";

// Configure before importing the server (it reads env at module top level).
process.env.PORT = "0";
process.env.NODE_ENV = "production";

const { server } = await import("../server.ts");
const base = `http://localhost:${server.port}`;

// ── Self-contained PNG generator (no fixtures, no deps) ──────────────────────
function makePng(w = 64, h = 48): Uint8Array {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t);
    body.set(data, t.length);
    const out = new Uint8Array(12 + data.length);
    out.set(u32(data.length));
    out.set(body, 4);
    out.set(u32(crc32(body)), 8 + data.length);
    return out;
  };

  const raw = new Uint8Array(h * (1 + w * 4));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[p++] = Math.round((255 * x) / (w - 1));
      raw[p++] = Math.round((255 * y) / (h - 1));
      raw[p++] = 128;
      raw[p++] = 255;
    }
  }

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(w), 0);
  ihdr.set(u32(h), 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // bit depth 8, color type 6 (RGBA)

  const idat = deflateSync(Buffer.from(raw));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, a) => n + a.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { png.set(part, off); off += part.length; }
  return png;
}

async function upload(png: Uint8Array, name = "test.png", type = "image/png") {
  const fd = new FormData();
  fd.append("file", new Blob([png], { type }), name);
  const res = await fetch(base + "/api/upload", { method: "POST", body: fd });
  return res;
}

// Shared state across tests (upload once).
let id = "";
let uploadedSize = 0;
let caps: Record<string, boolean> = {};

beforeAll(async () => {
  caps = await (await fetch(base + "/api/capabilities")).json();
});

afterAll(() => {
  server.stop(true);
});

// ── Static / meta ────────────────────────────────────────────────────────────
describe("static + capabilities", () => {
  it("serves the HTML entry at /", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Bun Image Tools");
    expect(html).toContain("app.js");
  });

  it("reports encoder capabilities", async () => {
    const res = await fetch(base + "/api/capabilities");
    expect(res.status).toBe(200);
    expect(caps.jpeg).toBe(true);
    expect(caps.png).toBe(true);
    expect(caps.webp).toBe(true);
    // avif/heic are platform-dependent (false on Linux) — just require the keys.
    expect("avif" in caps).toBe(true);
    expect("heic" in caps).toBe(true);
  });

  it("404s unknown routes as JSON", async () => {
    const res = await fetch(base + "/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });
});

// ── Upload ───────────────────────────────────────────────────────────────────
describe("POST /api/upload", () => {
  it("rejects a request with no file", async () => {
    const res = await fetch(base + "/api/upload", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  it("rejects non-image bytes", async () => {
    const res = await upload(new TextEncoder().encode("not an image"), "x.png");
    expect(res.status).toBe(400);
  });

  it("accepts a PNG and returns metadata + placeholder", async () => {
    const png = makePng(64, 48);
    const res = await upload(png);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toMatch(/^img_\d+$/);
    expect(data.width).toBe(64);
    expect(data.height).toBe(48);
    expect(data.size).toBe(png.length);
    expect(data.format).toBe("png");
    expect(typeof data.placeholder).toBe("string");
    expect(data.placeholder.startsWith("data:")).toBe(true);
    id = data.id;
    uploadedSize = data.size;
  });
});

// ── Metadata / original ──────────────────────────────────────────────────────
describe("info + original", () => {
  it("returns metadata for a stored image", async () => {
    const res = await fetch(`${base}/api/info/${id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.width).toBe(64);
    expect(data.height).toBe(48);
    expect(data.size).toBe(uploadedSize);
  });

  it("returns the original bytes unchanged", async () => {
    const res = await fetch(`${base}/api/original/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(uploadedSize);
    // PNG signature
    expect([...buf.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns a placeholder for a stored image", async () => {
    const res = await fetch(`${base}/api/placeholder/${id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.placeholder.startsWith("data:")).toBe(true);
  });

  it("404s unknown ids", async () => {
    expect((await fetch(`${base}/api/info/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/api/original/does-not-exist`)).status).toBe(404);
  });
});

// ── Compress / convert ───────────────────────────────────────────────────────
describe("GET /api/compress/:id", () => {
  it("encodes JPEG with size headers", async () => {
    const res = await fetch(`${base}/api/compress/${id}?format=jpeg&quality=50`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(parseInt(res.headers.get("X-Original-Size")!)).toBe(uploadedSize);
    expect(parseInt(res.headers.get("X-Compressed-Size")!)).toBeGreaterThan(0);
    expect(res.headers.get("X-Output-Format")).toBe("jpeg");
    expect(res.headers.get("X-Compression-Ratio")).toMatch(/%$/);
  });

  it("encodes WebP", async () => {
    const res = await fetch(`${base}/api/compress/${id}?format=webp&quality=70`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  it("encodes indexed-palette PNG", async () => {
    const res = await fetch(`${base}/api/compress/${id}?format=png&palette=true&colors=64&dither=true`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("resizes with fit=inside and reports new dimensions", async () => {
    const res = await fetch(`${base}/api/compress/${id}?width=32&fit=inside&format=jpeg`);
    expect(res.status).toBe(200);
    expect(parseInt(res.headers.get("X-Compressed-Width")!)).toBe(32);
  });

  it("applies color modulation (greyscale + brightness)", async () => {
    const res = await fetch(`${base}/api/compress/${id}?greyscale=true&brightness=1.2&format=jpeg`);
    expect(res.status).toBe(200);
  });

  it("applies rotate/flip without error", async () => {
    const res = await fetch(`${base}/api/compress/${id}?rotate=90&flip=true&flop=true&format=jpeg`);
    expect(res.status).toBe(200);
    expect(parseInt(res.headers.get("X-Compressed-Height")!)).toBe(64); // 64x48 rotated -> 48x64
  });

  it("rejects an invalid format", async () => {
    const res = await fetch(`${base}/api/compress/${id}?format=bmp`);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid filter", async () => {
    const res = await fetch(`${base}/api/compress/${id}?filter=notreal`);
    expect(res.status).toBe(400);
  });

  it("gates AVIF on platform support", async () => {
    const res = await fetch(`${base}/api/compress/${id}?format=avif`);
    if (caps.avif) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/avif");
    } else {
      expect(res.status).toBe(501);
      expect((await res.json()).error).toContain("not supported");
    }
  });

  it("404s a missing image", async () => {
    expect((await fetch(`${base}/api/compress/nope?format=jpeg`)).status).toBe(404);
  });
});
