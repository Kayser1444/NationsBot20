FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs card-index.json default-weights.json trained-weights.json models.json human-baseline.json baseline-info.json predictor-rules.json ./
ENV NATIONS_PLAYER_WEIGHTS=/app/trained-weights.json
CMD ["node", "worker.mjs"]
