FROM node:24-bookworm

# Install Xvfb for headed mode (not included in patchright's --with-deps)
RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Install Chromium browser and its system dependencies
# --with-deps installs required apt packages automatically
RUN pnpm exec patchright install --with-deps chromium

COPY . .

RUN pnpm run build

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
# Use exec to replace the shell with pnpm start for proper signal handling\n\
exec pnpm start' > /usr/src/app/start.sh && chmod +x /usr/src/app/start.sh

CMD [ "/usr/src/app/start.sh" ]
