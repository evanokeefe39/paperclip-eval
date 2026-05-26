FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN pip3 install --break-system-packages scrapling
RUN npm install -g cheerio

WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY skills/ /app/skills/
COPY researcher/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY researcher/.pi/agent/models.json /root/.pi/agent/models.json
COPY researcher/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY researcher/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY researcher/AGENTS.md /app/AGENTS.md
COPY researcher/scripts/ /app/scripts/

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents || true

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
