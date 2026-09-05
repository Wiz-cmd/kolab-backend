# ── Build stage ────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install deps (needed for prisma generate + nest build)
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci || npm install
RUN npx prisma generate

# Copy the rest of the app and build
COPY . .
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY prisma ./prisma
# Install production deps only
RUN npm ci --omit=dev || npm install --omit=dev
RUN npx prisma generate

COPY --from=build /app/dist ./dist

# Non-root user for safety
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/prisma/seed.js && node dist/src/main.js"]
