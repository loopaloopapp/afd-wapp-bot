FROM node:20-slim

# Installiamo git (necessario per alcune dipendenze di Baileys)
RUN apt-get update && apt-get install -y \
    git \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]
