FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs dashboard.html ./
ENV NODE_ENV=production
CMD ["node", "start-cloud.mjs"]
