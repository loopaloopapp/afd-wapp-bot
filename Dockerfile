FROM ghcr.io/puppeteer/puppeteer:latest

# Use root to ensure we can set up the working directory
USER root
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Set dynamic port (Railway handles this)
EXPOSE 8080

# Run the bot
CMD ["node", "bot.js"]
