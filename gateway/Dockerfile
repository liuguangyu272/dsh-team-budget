FROM node:24-alpine
WORKDIR /app
COPY package.json server.js store.js pricing.js ./
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8791 GATEWAY_DATA_DIR=/data
EXPOSE 8791
CMD ["node", "server.js"]
