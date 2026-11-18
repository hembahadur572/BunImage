# Bun Image Tools — Dockerfile
# Multi-stage: build, then run with the Bun runtime (>= 1.4 for Bun.Image,
# Bun.serve routes, and HTML imports).

FROM oven/bun:1.4 AS builder
WORKDIR /app
COPY server.ts index.html styles.css app.js ./

FROM oven/bun:1.4 AS runner
WORKDIR /app
COPY --from=builder /app /app
ENV NODE_ENV=production
EXPOSE 3000
VOLUME /app/uploads
CMD ["bun", "run", "server.ts"]
