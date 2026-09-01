# Stage 1: Build
FROM node:22 AS builder
WORKDIR /app
RUN corepack enable pnpm

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/admin/package.json apps/admin/

# Install without --frozen-lockfile so pnpm fetches the correct
# platform-specific native bindings (e.g. tailwindcss-oxide for linux).
RUN pnpm install --filter=@byos/admin

COPY apps/admin/ apps/admin/

RUN pnpm --filter=@byos/admin run build

# Stage 2: Runtime (standalone output is self-contained)
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=builder /app/apps/admin/.next/standalone ./
COPY --from=builder /app/apps/admin/.next/static apps/admin/.next/static/
COPY --from=builder /app/apps/admin/public apps/admin/public/

EXPOSE 3000
CMD ["node", "apps/admin/server.js"]
