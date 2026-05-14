# Bun Image Compress

Zero-dependency image compression app using Bun's native Image API. Compress, resize, and convert images — no npm packages needed.

## Quick Start

```bash
bun run server.ts
# → http://localhost:3000
```

### Docker

```bash
docker compose up -d
# → http://localhost:3000
```

## Features

- **Upload** images via drag-and-drop, file picker, or **paste from clipboard** (PNG, JPEG, WebP, BMP, GIF)
- **Compress** with adjustable quality (1–100)
- **Instant local preview** — see the image immediately before it's uploaded
- **Upload progress bar** — real-time feedback during upload
- **Client-side validation** — file type and size checked before upload
- **Server-side limit** — max 50 MB per upload
- **Convert** between JPEG, WebP, and PNG formats
- **Resize** with `fill` (exact stretch) or `inside` (shrink to fit) modes
  - **Resampling filters**: lanczos3 (default), lanczos2, mitchell, cubic, bilinear, box, nearest, mks2013, mks2021
  - **No-upscale** option to prevent enlarging small images
- **Transforms**: rotate (90°/180°/270°), flip vertical, flip horizontal
- **Color**: adjust brightness and saturation (greyscale support)
- **Live preview** with before/after comparison slider (debounced)
- **View stats** — original vs compressed size, savings %, dimensions
- **Keyboard shortcut**: Escape to reset
- **Persistent storage** — images survive server restarts (stored in `uploads/`)
- **Download** the result with original filename

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload image (multipart `file` field) |
| `GET` | `/api/compress/:id` | Compress with query params: `quality`, `format`, `width`, `height`, `fit`, `filter`, `withoutEnlargement`, `rotate`, `flip`, `flop`, `brightness`, `saturation` |
| `GET` | `/api/info/:id` | Get image metadata |
| `GET` | `/api/original/:id` | Get original image bytes |

## How it works

Bun's `Bun.Image` decodes images using:
- **libjpeg-turbo** — JPEG
- **spng** — PNG
- **libwebp** — WebP
- **Highway SIMD** — resize/geometry transforms

All statically linked — no system dependencies beyond what Bun ships.

Images are stored on disk in `uploads/` and expire 30 minutes after upload.
