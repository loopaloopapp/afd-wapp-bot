FROM node:20-slim

# Install git and openssh-client (needed for Baileys transitive dependencies)
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Rewrite SSH git URLs to HTTPS (no SSH keys available in build environment)
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]
