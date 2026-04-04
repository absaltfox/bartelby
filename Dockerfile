FROM node:20-slim

# Install system dependencies for canvas, sharp, pdfjs-dist, and poppler (pdftoppm)
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
    python3-pip \
    python3-dev \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Install Python ML dependencies for BERTopic analysis
RUN pip3 install --no-cache-dir -r requirements.txt

# Create data and temp directories
RUN mkdir -p /app/data /app/temp /app/public/uploads

# Default environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

# Run as non-root user
RUN addgroup --system app && adduser --system --ingroup app app
RUN chown -R app:app /app
USER app

CMD ["node", "server.js"]
