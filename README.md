# Bun Image Tools

Zero-dependency image compression app using Bun's native Image API. Compress,
resize, convert, and transform images — no npm packages needed. The server uses
`Bun.serve()` declarative routes with an HTML entry, so the page and its assets
are bundled by Bun (with hot reload in development).

## Requirements

Bun **>= 1.4** (for `Bun.Image`, `Bun.serve` routes, and HTML imports).

## Quick Start

```bash
bun install           # optional — only for @types/bun editor hints
bun run dev           # hot-reload dev server
# or
bun run start         # production
# → http://localhost:3000
```

### Docker

```bash
docker compose up -d
# → http://localhost:3000
```

> **AVIF note:** AVIF/HEIC encoding requires OS codecs and is unavailable on
> Linux, so it is disabled in Docker. JPEG/PNG/WebP work everywhere and are
> byte-identical across platforms.

## Tests

```bash
bun test
```

The suite (`tests/api.test.ts`) boots the real server on a random port and
exercises upload, metadata, original bytes, the placeholder, and every
compress/convert path (formats, resize, transforms, palette PNG, platform-gated
AVIF). It generates its own PNG in-process — no fixtures, no dependencies.

## Features

- **Upload** via drag-and-drop, file picker, or **paste from clipboard** (Ctrl/Cmd+V)
- **One-click presets** — Web (WebP q75), Social (JPEG 1200px), Thumbnail (400px),
  Lossless WebP, Screenshot (indexed-palette PNG)
- **Compress** with adjustable quality (1–100)
- **Convert** between JPEG, WebP, PNG, and AVIF (where supported)
- **Resize** with `fill` (exact stretch) or `inside` (shrink to fit) modes
  - **Resampling filters**: lanczos3 (default), lanczos2, mitchell, cubic, bilinear, box, nearest, mks2013, mks2021
  - **No-upscale** option and aspect-ratio lock
- **Transforms**: rotate (90°/180°/270°), flip vertical, flip horizontal
- **Color**: brightness, saturation, and greyscale (`modulate`)
- **Advanced encode options**: lossless WebP, progressive JPEG, PNG compression
  level, indexed-palette PNG (`colors` + Floyd–Steinberg dither)
- **Live preview** with a before/after comparison slider (debounced, click-to-move
  and arrow-key accessible)
- **ThumbHash placeholder** — a blurred inline image shown while the full image loads
- **Richer stats** — original vs processed size, savings %, dimensions, output
  format, size ratio
- **Keyboard shortcuts**: Escape to reset, Ctrl/Cmd+S to download
- **Persistent storage** — images survive server restarts (stored in `uploads/`)
- **Download** the result with the original filename

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/` | The app (HTML entry, bundled) |
| `POST` | `/api/upload` | Upload image (multipart `file` field) → `{ id, width, height, size, type, format, placeholder }` |
| `GET`  | `/api/compress/:id` | Compress/convert — see query params below |
| `GET`  | `/api/info/:id` | Image metadata |
| `GET`  | `/api/original/:id` | Original image bytes |
| `GET`  | `/api/placeholder/:id` | ThumbHash placeholder data URL (`{ placeholder }`) |
| `GET`  | `/api/capabilities` | `{ jpeg, png, webp, avif, heic }` — encoder availability on this platform |

### `/api/compress/:id` query params

All optional. Invalid values fall back to defaults or return `400`.

| Param | Default | Description |
|-------|---------|-------------|
| `quality` | `80` | 1–100 (JPEG/WebP/AVIF/HEIC) |
| `format` | `jpeg` | `jpeg` \| `png` \| `webp` \| `avif` \| `heic` |
| `width`, `height` | original | Target dimensions |
| `fit` | `inside` | `inside` \| `fill` |
| `filter` | `lanczos3` | Resampling kernel |
| `withoutEnlargement` | `false` | Never upscale |
| `rotate` | `0` | `90` \| `180` \| `270` |
| `flip`, `flop` | `false` | Vertical / horizontal mirror |
| `brightness`, `saturation` | `1` | `modulate` multipliers |
| `greyscale` | `false` | Shortcut for `saturation=0` |
| `lossless` | `false` | Lossless WebP |
| `progressive` | `false` | Progressive JPEG |
| `compressionLevel` | `6` | PNG zlib level 0–9 |
| `palette`, `colors`, `dither` | `false`, `256`, `false` | Indexed-palette PNG |

Response headers include `X-Original-Size`, `X-Compressed-Size`,
`X-Compression-Ratio`, `X-Compressed-Width`, `X-Compressed-Height`, and
`X-Output-Format`.

## How it works

`Bun.Image` decodes and encodes using:
- **libjpeg-turbo** — JPEG
- **spng** — PNG
- **libwebp** — WebP
- **Highway SIMD** — resize/geometry transforms

All statically linked — no system dependencies beyond what Bun ships.

Images are stored on disk in `uploads/` and expire 30 minutes after upload.
Expired images are cleaned up by a `Bun.cron` job (falling back to `setInterval`).
