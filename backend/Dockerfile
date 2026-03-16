# 1. Use standard Node image
FROM node:22-slim

# 2. SPEED BOOST: Copy pre-built FFmpeg binaries
# This replaces the slow "apt-get install ffmpeg" step.
# It downloads instantly and caches perfectly.
COPY --from=mwader/static-ffmpeg:6.0 /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:6.0 /ffprobe /usr/local/bin/

# 3. Install Python 3 + pip for marker-pdf (PDF → HTML conversion)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# 4. Install marker-pdf in a virtual environment
# marker-pdf uses PyTorch + surya (OCR/layout) + texify (math) for high-quality PDF conversion.
# Models are downloaded on first use and cached.
RUN python3 -m venv /opt/marker-venv \
    && /opt/marker-venv/bin/pip install --no-cache-dir marker-pdf

# Make marker_single available on PATH
ENV PATH="/opt/marker-venv/bin:$PATH"

WORKDIR /app

# 5. Copy package files
COPY package*.json ./

# 6. Install dependencies (uses cache if package.json hasn't changed)
RUN npm ci

# 7. Copy application code
COPY . .

# 8. Build TypeScript
RUN npm run build

# 9. Expose port
EXPOSE 3001

# 10. Start the application
CMD ["npm", "start"]
