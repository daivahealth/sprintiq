# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
# Prisma's schema and query engines are native binaries that link against
# libssl; node:*-alpine ships without it. Missing, the engine fails to load —
# which breaks `migrate deploy` AND every query the app makes, with an error
# that names JSON parsing rather than the actual cause.
RUN apk add --no-cache openssl
COPY package*.json ./
# Schema BEFORE install: `postinstall` runs `prisma generate`, which fails
# without a schema to generate from.
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Prisma's schema and query engines are native binaries that link against
# libssl; node:*-alpine ships without it. Missing, the engine fails to load —
# which breaks `migrate deploy` AND every query the app makes, with an error
# that names JSON parsing rather than the actual cause.
RUN apk add --no-cache openssl
COPY package*.json ./
# `prisma/` ships in the runtime image, not just the build one: it carries the
# migration files, and `start:prod` applies them on boot. Without it the image
# can only ever run against a database someone migrated by hand.
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# APP_ROLE selects the process responsibilities: api | collector | worker
ENV APP_ROLE=api
EXPOSE 3000
# `npm run start:prod`, not `node dist/main.js` — the script applies pending
# migrations first, so a deploy carrying a schema change works on arrival
# instead of needing a remembered manual step.
CMD ["npm", "run", "start:prod"]
