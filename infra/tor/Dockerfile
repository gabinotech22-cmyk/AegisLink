# AegisLink — Tor onion-service sidecar for the relay (Fase 4 · mailbox mode).
# Built from the official Alpine tor package instead of a third-party image:
# auditable supply chain, ~15 MB, and apk keeps tor patched on rebuild.
FROM alpine:3.24

RUN apk add --no-cache tor

# torrc is baked into the image (config is code); the onion identity key is
# NOT — it lives in the tor_keys volume mounted at /var/lib/tor so the .onion
# address survives container rebuilds.
COPY torrc /etc/tor/torrc

# The alpine tor package creates the `tor` user and /var/lib/tor (0700,
# tor:tor). The named volume inherits that ownership on first use, which is
# exactly what tor demands for its DataDirectory.
USER tor

# Unhealthy until the onion service has generated its identity (hostname file).
# start-period covers first-boot key generation + descriptor publication.
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=5 \
  CMD test -s /var/lib/tor/aegislink_relay/hostname || exit 1

CMD ["tor", "-f", "/etc/tor/torrc"]
