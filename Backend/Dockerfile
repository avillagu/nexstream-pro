FROM node:18-alpine

# Install Python 3, yt-dlp, ffmpeg and curl
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    curl \
    && pip3 install --break-system-packages yt-dlp \
    && ln -sf python3 /usr/bin/python

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY server.js ./

# Create temp directory
RUN mkdir -p /app/temp

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start the server
CMD ["node", "server.js"]
