FROM node:20-slim

WORKDIR /app

# Non servono più librerie per Chromium! 
# Baileys è puro JavaScript.

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]
