FROM node:20-slim

# Install system dependencies for canvas, sharp, and pdfjs-dist
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data and temp directories
RUN mkdir -p /app/data /app/temp /app/public/uploads

# Default environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as non-root user
RUN addgroup --system app && adduser --system --ingroup app app
RUN chown -R app:app /app
USER app

CMD ["node", "server.js"]
