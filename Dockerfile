# Hosted, multi-tenant HTTP MCP endpoint.
# Build:  docker build -t aacworkflow-mcp .
# Run:    docker run -p 8787:8787 -e AACWORKFLOW_SERVER_URL=https://aacworkflow.com aacworkflow-mcp
# Each client authenticates per-request with its own Bearer token.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/http.js"]
