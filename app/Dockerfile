FROM node:20-alpine

# Install curl for health checks and debugging
RUN apk add --no-cache curl

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY src/ ./src/

# Expose API port
EXPOSE 3000

CMD ["node", "src/index.js"]
