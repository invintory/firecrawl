FROM node:18-slim

# Install dependencies for Chromium and Xvfb for headed mode
RUN apt-get update && apt-get install -y \
    xvfb \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcursor1 \
    libxi6 \
    libxtst6 \
    libgtk-3-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# Install browsers using npx to ensure we use the project's patchright version
# This ensures compatibility between the patchright library and browser versions
RUN npx patchright install chrome

COPY . .

RUN npm run build

ARG PORT
ENV PORT=${PORT}

# Set display environment variable for Xvfb
ENV DISPLAY=:99

EXPOSE ${PORT}

# Create a script to start Xvfb and the application
RUN echo '#!/bin/bash\n\
# Clean up any existing lock files\n\
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99\n\
# Start Xvfb in the background\n\
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -nolisten unix &\n\
# Wait for Xvfb to be ready\n\
sleep 2\n\
# Use exec to replace the shell with npm start for proper signal handling\n\
exec npm start' > /usr/src/app/start.sh && chmod +x /usr/src/app/start.sh

CMD [ "/usr/src/app/start.sh" ]
