FROM node:22
ENV NODE_ENV=production \
    UMA_BASE=http://localhost:4000/ \
    DATA_DIR=/data \
    LOG_LEVEL=info

# Install EYE reasoner
RUN apt-get update  \
 && apt-get install swi-prolog -y \
 && git clone https://github.com/eyereasoner/eye.git \
 && /eye/install.sh --prefix=/usr/local \
 && rm -r /eye

WORKDIR /app
COPY . .

RUN corepack enable yarn \
 && yarn install \
 && yarn build \
 && chown -R node /app

# Ensure data dir exists inside image (can be overridden by volume)
RUN mkdir -p /data && chown -R node:node /data

WORKDIR /app/packages/css
EXPOSE 3000

USER node
CMD ["/bin/sh","-lc","yarn run community-solid-server -m . -c ./config/default.json -p 3000 -a \"${UMA_BASE}\" -f \"${DATA_DIR}\" -l \"${LOG_LEVEL}\""]
