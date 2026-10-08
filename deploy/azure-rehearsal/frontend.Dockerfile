FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG SIGNUP_LEGAL_ACCEPTANCES_JSON
RUN VITE_SIGNUP_LEGAL_ACCEPTANCES_JSON="$SIGNUP_LEGAL_ACCEPTANCES_JSON" npm run build

FROM caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY --from=build /app/dist /srv
COPY --from=rehearsal_config Caddyfile /etc/caddy/Caddyfile
# The upstream binary has cap_net_bind_service. Listening on 8080 needs no
# file capability; remove it so cap_drop: ALL can execute it as UID 1000.
RUN setcap -r /usr/bin/caddy
USER 1000:1000
EXPOSE 8080
