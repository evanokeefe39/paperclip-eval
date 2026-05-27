FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN pip3 install --break-system-packages "scrapling[fetchers]"
RUN npm install -g cheerio

ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /app

COPY bridge.mjs .

# Universal extensions
COPY extensions/types/ /app/extensions/types/
COPY extensions/artifacts.ts /app/extensions/
COPY extensions/logging.ts /app/extensions/
COPY extensions/logging/ /app/extensions/logging/
COPY extensions/escalate.ts /app/extensions/

# Researcher-specific extensions
COPY extensions/web-search.ts /app/extensions/
COPY extensions/web-fetch.ts /app/extensions/
COPY extensions/web-scrape.ts /app/extensions/
COPY extensions/deep-research.ts /app/extensions/
COPY extensions/deep-research/ /app/extensions/deep-research/
COPY extensions/findings.ts /app/extensions/

# Skills
COPY skills/_client.ts /app/skills/
COPY skills/paperclip-tools.ts /app/skills/
COPY skills/paperclip-skills/ /app/skills/paperclip-skills/

# Agent config
COPY researcher/.pi/agent/ /root/.pi/agent/
COPY researcher/scripts/ /app/scripts/

RUN pi extensions install || true

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
