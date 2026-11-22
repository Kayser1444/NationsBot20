FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3-numpy && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs card-index.json default-weights.json trained-weights.json models.json human-baseline.json baseline-info.json predictor-rules.json default-specials.json ./
COPY round-search/ ./round-search/
ENV NATIONS_PLAYER_WEIGHTS=/app/trained-weights.json
CMD ["node", "worker.mjs"]
