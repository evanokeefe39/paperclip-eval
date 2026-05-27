FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

ARG AGENT_NAME
WORKDIR /app

COPY bridge.mjs .

# Universal extensions (every agent)
COPY extensions/types/ /app/extensions/types/
COPY extensions/artifacts.ts /app/extensions/
COPY extensions/logging.ts /app/extensions/
COPY extensions/logging/ /app/extensions/logging/
COPY extensions/escalate.ts /app/extensions/

# CEO-specific extensions
COPY extensions/web-search.ts /app/extensions/
COPY extensions/triage-workflow.ts /app/extensions/

# Skills (universal)
COPY skills/_client.ts /app/skills/
COPY skills/paperclip-tools.ts /app/skills/
COPY skills/paperclip-skills/ /app/skills/paperclip-skills/

# Agent config + templates
COPY ${AGENT_NAME}/.pi/agent/ /root/.pi/agent/
COPY templates/ /app/templates/
ENV AGENT_NAME=${AGENT_NAME}

RUN pi extensions install || true

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
