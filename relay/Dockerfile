FROM node:20-bookworm-slim

# Build tools for better-sqlite3 native compilation (falls back from prebuilt if needed).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8787
ENV DB_PATH=/data/relay.db
EXPOSE 8787

CMD ["node", "server.js"]
