FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV AGENTGC_DATA=/data PORT=4747
VOLUME /data
EXPOSE 4747
CMD ["node", "bin/agentgc.js", "serve"]
