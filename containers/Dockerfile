FROM node:22-bookworm-slim
ARG RUNTIME
LABEL org.kars.runtime.contract="v1"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 ripgrep iptables \
    && rm -rf /var/lib/apt/lists/*
RUN case "$RUNTIME" in \
      claude) package='@anthropic-ai/claude-code@2.1.263' ;; \
      copilot) package='@github/copilot@1.0.83' ;; \
      codex) package='@openai/codex@0.152.0' ;; \
      *) echo 'RUNTIME must be claude, copilot, or codex' >&2; exit 1 ;; \
    esac \
    && npm install --global --registry=https://packagefeedproxy.microsoft.io/npm/ "$package" \
    && npm cache clean --force
ENV NODE_ENV=production \
    HOME=/sandbox/home \
    KARS_RUNTIME=$RUNTIME \
    PORT=8080 \
    NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
RUN mkdir -p /sandbox/home /sandbox/agent /opt/kars-byo/runtime \
    && chown -R 1000:1000 /sandbox
COPY runtime/ /opt/kars-byo/runtime/
VOLUME ["/sandbox"]
WORKDIR /sandbox/agent
USER 1000:1000
EXPOSE 8080
CMD ["node", "/opt/kars-byo/runtime/server.mjs"]
