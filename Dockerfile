FROM node:20-slim

# Install all dependencies required by Playwright's Chromium
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    fontconfig \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json (and package-lock.json if exists, but not required)
COPY package*.json ./

# Install Node dependencies – using install because ci needs lockfile
RUN npm install

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium

# Copy application files
COPY server.js ./
COPY utils.js ./
# Add any other files (e.g., .env) if needed

EXPOSE 7860

CMD ["node", "server.js"]