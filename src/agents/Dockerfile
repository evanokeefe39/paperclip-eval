# ============================================================
# BASE — shared by all agents
# ============================================================
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
ENV NODE_PATH=/usr/local/lib/node_modules
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.mjs logger.mjs ./
COPY extensions/ /root/.pi/agent/extensions/
COPY skills/paperclip-skills/ /app/skills/paperclip-skills/
COPY skills/paperclip-skills/ /root/.pi/agent/skills/
RUN pi extensions install || true
RUN mkdir -p /workspace
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

# ============================================================
# LIGHTWEIGHT AGENTS — ceo, coder, qa, publisher
# ============================================================
FROM base AS ceo
COPY ceo/.pi/agent/ /root/.pi/agent/

FROM base AS coder
COPY coder/.pi/agent/ /root/.pi/agent/

FROM base AS qa
COPY qa/.pi/agent/ /root/.pi/agent/

FROM base AS publisher
COPY publisher/.pi/agent/ /root/.pi/agent/

# ============================================================
# RESEARCHER — lightweight scraping (Python + Scrapling + Cheerio)
# ============================================================
FROM base AS researcher-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages "scrapling[fetchers]"
RUN npm install -g cheerio

FROM researcher-deps AS researcher
COPY researcher/.pi/agent/ /root/.pi/agent/
COPY researcher/scripts/ /app/scripts/

# ============================================================
# DATA — heavy scraping (browser + ffmpeg + DuckDB)
# ============================================================
FROM researcher-deps AS data-deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
RUN scrapling install
RUN npm install -g @duckdb/node-api

FROM data-deps AS data
COPY data/.pi/agent/ /root/.pi/agent/
COPY data/scripts/ /app/scripts/
RUN touch /app/.browsers-installed

# ============================================================
# WRITER — vale linter
# ============================================================
FROM base AS writer-deps
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN curl -sfL --retry 3 --retry-delay 2 -o /tmp/vale.tar.gz \
    https://github.com/errata-ai/vale/releases/download/v3.11.2/vale_3.11.2_Linux_64-bit.tar.gz \
  && tar xzf /tmp/vale.tar.gz -C /usr/local/bin vale && rm /tmp/vale.tar.gz

FROM writer-deps AS writer
COPY writer/.pi/agent/ /root/.pi/agent/
COPY data/style/ /app/data/style/
