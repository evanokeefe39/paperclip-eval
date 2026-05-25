FROM node:22-slim

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

ARG AGENT_NAME
WORKDIR /app

COPY bridge.mjs .
COPY ${AGENT_NAME}/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY ${AGENT_NAME}/.pi/agent/models.json /root/.pi/agent/models.json
COPY ${AGENT_NAME}/AGENTS.md /app/AGENTS.md

RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]