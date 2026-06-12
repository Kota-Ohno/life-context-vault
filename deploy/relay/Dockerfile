# syntax=docker/dockerfile:1

FROM rust:1.77-bookworm AS builder

WORKDIR /app
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs src-tauri/tauri.conf.json ./src-tauri/
COPY src-tauri/capabilities ./src-tauri/capabilities
COPY src-tauri/icons ./src-tauri/icons
COPY src-tauri/src ./src-tauri/src
RUN cargo build --release --manifest-path src-tauri/Cargo.toml --bin lcv-relay

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --home /nonexistent --shell /usr/sbin/nologin lcv \
  && mkdir -p /data \
  && chown -R lcv:lcv /data

COPY --from=builder /app/src-tauri/target/release/lcv-relay /usr/local/bin/lcv-relay

ENV LCV_RELAY_BIND=0.0.0.0:8765 \
  LCV_RELAY_ALLOW_DIRECT_SIDECAR=0 \
  LCV_RELAY_STATE_PATH=/data/relay-state.json \
  LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS=30 \
  LCV_RELAY_HANDOFF_TTL_SECONDS=600

VOLUME ["/data"]
EXPOSE 8765
USER lcv

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8765/health >/dev/null || exit 1

ENTRYPOINT ["lcv-relay"]
