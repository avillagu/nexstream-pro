FROM node:18-alpine

# Install Python 3, ffmpeg, curl and ca-certificates
RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    ca-certificates

# Install yt-dlp binary directly (often more stable in Alpine)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    ln -sf /usr/local/bin/yt-dlp /usr/bin/yt-dlp

# Verify installations
RUN ffmpeg -version && yt-dlp --version

# Set working directory
WORKDIR /app

# Copy package files
COPY Backend/package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY Backend/server.js ./

# Create temp directory
RUN mkdir -p /app/temp

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start the server
CMD ["node", "server.js"]
