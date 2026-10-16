# Build context is the repository root, so the shared proto/ is available.
FROM node:24-slim AS build
WORKDIR /app
COPY orders/package.json orders/package-lock.json ./
RUN npm ci
COPY orders/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production PROTO_DIR=/app/proto
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY orders/migrations migrations
COPY proto proto
USER node
EXPOSE 3000
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]
