# 1. Use standard Node image
FROM node:22-slim

# 2. SPEED BOOST: Copy pre-built FFmpeg binaries
# This replaces the slow "apt-get install ffmpeg" step.
# It downloads instantly and caches perfectly.
COPY --from=mwader/static-ffmpeg:6.0 /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:6.0 /ffprobe /usr/local/bin/

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
