FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    HOME=/home/node \
    WORKSPACE_DIR=/workspace \
    FILES_DIR=/files \
    STATE_DIR=/home/node/.pi-foundry \
    SESSIONS_DIR=/home/node/.pi-foundry/sessions \
    PI_CODING_AGENT_DIR=/home/node/.pi-foundry/pi-agent \
    PI_ARGS="--mode rpc --no-session"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uvx --version \
    && npm install -g @earendil-works/pi-coding-agent@0.75.5 --ignore-scripts \
    && mkdir -p /app /files /workspace /home/node/.pi-foundry \
    && chown -R node:node /app /files /workspace /home/node \
    && runuser -u node -- uvx edge-tts --help >/dev/null

USER node
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node .agents/skills /workspace/.agents/skills
COPY --chown=node:node demo-workspace /workspace

EXPOSE 8088
CMD ["node", "src/server.mjs"]
