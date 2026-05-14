# Bun Image Compress — Dockerfile
# Multi-stage: install bun, copy app, run

FROM oven/bun:1 AS builder
WORKDIR /app
COPY server.ts index.html ./

FROM oven/bun:1 AS runner
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 3000
VOLUME /app/uploads
CMD ["bun", "run", "server.ts"]
