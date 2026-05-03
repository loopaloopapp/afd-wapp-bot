FROM node:20-slim

# Installiamo git e openssh-client
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Forziamo git a usare HTTPS invece di SSH per evitare problemi di chiavi
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]
