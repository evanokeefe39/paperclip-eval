FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

RUN curl -sfL https://github.com/errata-ai/vale/releases/download/v3.11.2/vale_3.11.2_Linux_64-bit.tar.gz | tar xz -C /usr/local/bin vale

ENV NODE_PATH=/usr/local/lib/node_modules

WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY skills/ /app/skills/
COPY data/style/ /app/data/style/
COPY writer/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY writer/.pi/agent/models.json /root/.pi/agent/models.json
COPY writer/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY writer/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY writer/AGENTS.md /app/AGENTS.md
COPY vale/ /app/vale/

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents npm:pi-otel || true

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
