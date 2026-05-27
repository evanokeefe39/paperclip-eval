FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ffmpeg \
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
RUN npm install -g cheerio @duckdb/node-api

ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /app

COPY bridge.mjs .

# Universal extensions
COPY extensions/types/ /app/extensions/types/
COPY extensions/artifacts.ts /app/extensions/
COPY extensions/logging.ts /app/extensions/
COPY extensions/logging/ /app/extensions/logging/
COPY extensions/escalate.ts /app/extensions/

# Data-specific extensions
COPY extensions/web-search.ts /app/extensions/
COPY extensions/web-fetch.ts /app/extensions/
COPY extensions/web-scrape.ts /app/extensions/
COPY extensions/duckdb.ts /app/extensions/
COPY extensions/duckdb/ /app/extensions/duckdb/
COPY extensions/findings.ts /app/extensions/

# Skills
COPY skills/_client.ts /app/skills/
COPY skills/paperclip-tools.ts /app/skills/
COPY skills/paperclip-skills/ /app/skills/paperclip-skills/

# Agent config
COPY data/.pi/agent/ /root/.pi/agent/
COPY data/scripts/ /app/scripts/

RUN pi extensions install || true

RUN touch /app/.browsers-installed
RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
