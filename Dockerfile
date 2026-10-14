FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs dashboard.html ./
COPY sm-season.json ./
COPY data/cards/catalog.json ./data/cards/
COPY data/cards/asset-manifest.json ./data/cards/
COPY public/card-assets/ ./public/card-assets/
COPY data/faq/entries.json data/faq/sources.json ./data/faq/
ENV NODE_ENV=production
CMD ["node", "start-cloud.mjs"]
