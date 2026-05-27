FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

RUN curl -sfL --retry 3 --retry-delay 2 -o /tmp/vale.tar.gz https://github.com/errata-ai/vale/releases/download/v3.11.2/vale_3.11.2_Linux_64-bit.tar.gz && tar xzf /tmp/vale.tar.gz -C /usr/local/bin vale && rm /tmp/vale.tar.gz

ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /app

COPY bridge.mjs .

# Universal extensions
COPY extensions/types/ /app/extensions/types/
COPY extensions/artifacts.ts /app/extensions/
COPY extensions/logging.ts /app/extensions/
COPY extensions/logging/ /app/extensions/logging/
COPY extensions/escalate.ts /app/extensions/

# Writer-specific extensions
COPY extensions/web-search.ts /app/extensions/
COPY extensions/web-fetch.ts /app/extensions/
COPY extensions/findings.ts /app/extensions/
COPY extensions/duckdb.ts /app/extensions/
COPY extensions/duckdb/ /app/extensions/duckdb/
COPY extensions/style-lint.ts /app/extensions/
COPY extensions/style-metrics.ts /app/extensions/
COPY extensions/style-profile.ts /app/extensions/
COPY extensions/workproduct/ /app/extensions/workproduct/

# Skills
COPY skills/_client.ts /app/skills/
COPY skills/paperclip-tools.ts /app/skills/
COPY skills/paperclip-skills/ /app/skills/paperclip-skills/

# Agent config + writer assets
COPY data/style/ /app/data/style/
COPY writer/.pi/agent/ /root/.pi/agent/
COPY vale/ /app/vale/

RUN pi extensions install || true

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
