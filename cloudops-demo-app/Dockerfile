# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# =========================================================================
FROM node:20-alpine AS runtime

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Create app directory
WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package*.json ./

# Install production dependencies
RUN (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)

# Copy application source code
COPY . .

# Expose application port
EXPOSE 3000

# Run as non-root node user for container security
USER node

# Start application
CMD ["npm", "start"]
