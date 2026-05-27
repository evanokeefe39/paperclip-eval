FROM oven/bun:alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
EXPOSE 8090
CMD ["bun", "run", "server.ts"]
