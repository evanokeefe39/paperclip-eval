FROM node:20-slim

RUN npm install -g @anthropic/pi

WORKDIR /app
COPY bridge.mjs .

RUN mkdir -p /workspace

EXPOSE 8080
CMD ["node", "bridge.mjs"]
