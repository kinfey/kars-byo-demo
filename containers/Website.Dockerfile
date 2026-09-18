FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY web/ web/
COPY vite.config.js ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    DATA_DIR=/data/agents
WORKDIR /app
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY package.json ./
COPY server/ server/
COPY runtime/ runtime/
COPY containers/Dockerfile containers/Dockerfile
RUN mkdir -p /data/agents && chown -R node:node /data
USER node
EXPOSE 4310
CMD ["node", "server/index.mjs"]
