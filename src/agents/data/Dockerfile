FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN pip3 install --break-system-packages "scrapling[fetchers]"
RUN scrapling install
RUN npm install -g cheerio

ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY skills/ /app/skills/
COPY data/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY data/.pi/agent/models.json /root/.pi/agent/models.json
COPY data/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY data/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY data/AGENTS.md /app/AGENTS.md
COPY data/scripts/ /app/scripts/

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents npm:pi-otel || true

RUN touch /app/.browsers-installed
RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
