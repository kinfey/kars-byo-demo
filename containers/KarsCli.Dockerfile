FROM node:22-bookworm-slim
LABEL org.kars.runtime.contract="v1"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl python3 ripgrep iptables chromium \
      libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --registry=https://packagefeedproxy.microsoft.io/npm/ \
      @anthropic-ai/claude-code@2.1.263 \
      @github/copilot@1.0.83 \
      @openai/codex@0.152.0 \
    && npm cache clean --force
WORKDIR /opt/kars-byo
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY containers/kars-chrome /usr/local/bin/kars-chrome
RUN chmod 0755 /usr/local/bin/kars-chrome \
    && ln -s kars-chrome /usr/local/bin/chrome \
    && ln -s kars-chrome /usr/local/bin/chromium \
    && ln -s kars-chrome /usr/local/bin/google-chrome \
    && ln -s kars-chrome /usr/local/bin/google-chrome-stable
ENV NODE_ENV=production \
    HOME=/sandbox/home \
    PORT=8080 \
    NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
    CHROME_BIN=/usr/local/bin/chrome
RUN mkdir -p /sandbox/agents /opt/kars-byo/runtime \
    && chown -R 1000:1000 /sandbox
COPY runtime/ /opt/kars-byo/runtime/
VOLUME ["/sandbox"]
WORKDIR /sandbox
USER 1000:1000
EXPOSE 8080
CMD ["node", "/opt/kars-byo/runtime/kars-copilot-server.mjs"]
