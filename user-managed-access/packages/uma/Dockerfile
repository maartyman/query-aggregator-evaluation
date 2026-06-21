FROM node:22
ENV NODE_ENV=production \
    BASE_URL=http://localhost:4000/uma \
    POLICY_BASE=http://localhost:3000/ \
    LOG_LEVEL=info

# Install EYE reasoner
RUN apt-get update  \
 && apt-get install swi-prolog -y \
 && git clone https://github.com/eyereasoner/eye.git \
 && /eye/install.sh --prefix=/usr/local \
 && rm -r /eye

WORKDIR /app
COPY . .

RUN corepack enable \
 && yarn install \
 && yarn build \
 && chown -R node /app

WORKDIR /app/packages/uma
EXPOSE 4000

USER node
CMD ["/bin/sh","-lc","node bin/main.js --port 4000 --base-url \"${BASE_URL}\" --policy-base \"${POLICY_BASE}\" --log-level \"${LOG_LEVEL}\""]
