FROM node:20-slim

# Installiamo i pacchetti necessari: git, ssh e i certificati SSL
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Forziamo git a usare HTTPS invece di SSH
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]
