# syntax=docker/dockerfile:1
# Lean, fast remote-MCP image for Coolify (Dockerfile build pack).
#   - alpine base, BuildKit npm cache mount → fast rebuilds
#   - prod-only node_modules, no dev junk in the final image
#   - non-root, healthcheck on /health
# Listens on $PORT (default 8787). In Coolify: set the domain to
# https://mcp.aacworkflow.com and "Ports Exposes" = 8787.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1
USER node
CMD ["node", "dist/http.js"]
