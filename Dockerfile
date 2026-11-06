# PermaBanNode — the web edition as a container app (TrueNAS Scale: Custom App / Docker Compose).
# Zero npm dependencies, so there is no install step to slow the build down.
FROM node:20-alpine

# Unprivileged user with fixed uid/gid 998 — TrueNAS ACLs on the dataset you mount are easier to set for a known id.
RUN addgroup -S -g 998 crowdsec-permaban && adduser -S -u 998 -G crowdsec-permaban crowdsec-permaban

# /data exists in the image, owned by uid/gid 998: Docker copies that ownership into a fresh **named volume**, so
# `docker run -v permaban-data:/data` is writable from the first launch. A bind-mounted dataset still needs an ACL
# for 998 (TrueNAS section in README); if it does not, the app opens read-only and serves with a banner, no crash loop.
RUN mkdir -p /data && chown crowdsec-permaban:crowdsec-permaban /data

WORKDIR /app
COPY core/ core/
COPY public/ public/
COPY server.js package.json ./

# Container defaults: data on the mounted volume, UI answering on every interface, standard port.
ENV NODE_ENV=production \
    PERMABAN_DATA_DIR=/data \
    PERMABAN_HOST=0.0.0.0 \
    PERMABAN_PORT=8780

VOLUME /data
EXPOSE 8780

# The healthcheck uses the same endpoint as the UI export links: process alive, store readable.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8780/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER crowdsec-permaban

# No volume mounted, or a read-only mount: the app opens the history read-only and keeps serving
# (see core/store.js), so there is no crash loop on permission problems — the banner says what happened.
CMD ["node", "server.js"]
