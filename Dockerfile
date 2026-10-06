

FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install git and ssh for GitHub dependencies
RUN apk add --no-cache git openssh-client \
    && git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global url."https://github.com/".insteadOf "git@github.com:"

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev) for build stage
RUN npm install

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build application (uses tsc from devDependencies)
RUN npm run build

# Prune devDependencies for production image
RUN npm prune --production

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 tatakai

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

USER tatakai

EXPOSE 4000

CMD ["node", "dist/src/server.js"]
