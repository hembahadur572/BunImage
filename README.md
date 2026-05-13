# Bun Image Compress

Zero-dependency image compression app using Bun's native Image API. Compress, resize, and convert images — no npm packages needed.

## Quick Start

```bash
bun run server.ts
# → http://localhost:3000
```

## Features

- **Upload** images via drag-and-drop or file picker (PNG, JPEG, WebP, BMP, GIF)
- **Compress** with adjustable quality (1–100)
- **Convert** between JPEG, WebP, and PNG formats
- **Resize** with `fill` (exact stretch) or `inside` (shrink to fit) modes
- **Preview** results inline before downloading
- **View stats** — original vs compressed size, savings %, dimensions

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload image (multipart `file` field) |
| `GET` | `/api/compress/:id` | Compress with query params: `quality`, `format`, `width`, `height`, `fit` |
| `GET` | `/api/info/:id` | Get image metadata |

## How it works

Bun's `Bun.Image` decodes images using:
- **libjpeg-turbo** — JPEG
- **spng** — PNG
- **libwebp** — WebP
- **Highway SIMD** — resize/geometry transforms

All statically linked — no system dependencies beyond what Bun ships.
