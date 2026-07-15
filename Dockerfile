FROM node:20-slim

# Install ffmpeg (needed for the actual video splitting)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads clips

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
