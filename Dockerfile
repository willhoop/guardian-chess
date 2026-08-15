# For Fly.io, Railway, a VPS, or anywhere else that takes a container.
# Render uses render.yaml instead and ignores this.
FROM node:22-alpine

WORKDIR /app

# Copy manifests first so the dependency layer caches between code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run as the unprivileged user the base image already provides.
USER node

CMD ["node", "server/index.js"]
