FROM node:25.9.0-slim

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
    python3-venv \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install JavaScript and Python dependencies first (layer caching)
COPY package.json package-lock.json ./
COPY requirements.txt ./
RUN npm ci --omit=dev
RUN python3 -m venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
  && python3 -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
  && python3 -m pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data and temp directories
RUN mkdir -p /app/data /app/data/uploads /app/temp /app/.cache/numba /app/.cache/huggingface

# Default environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/app
ENV XDG_CACHE_HOME=/app/.cache
ENV NUMBA_CACHE_DIR=/app/.cache/numba
ENV HF_HOME=/app/.cache/huggingface

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

# Run as non-root user
RUN addgroup --system app && adduser --system --ingroup app app
RUN chown -R app:app /app
USER app

CMD ["node", "server.js"]
