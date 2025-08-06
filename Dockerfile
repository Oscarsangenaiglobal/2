FROM node:18-slim

# Install system dependencies required by Puppeteer
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates fonts-liberation libasound2t64 libatk1.0-0 \
       libatk-bridge2.0-0 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
       libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libx11-6 \
       libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
       libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1 \
       libxss1 libxtst6 wget xdg-utils lsb-release \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .

CMD ["npm","run","fix-validate"]
