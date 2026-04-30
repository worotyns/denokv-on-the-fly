# Stage 1: Build denokv from source
FROM rust:1.80-slim-bookworm AS denokv-builder
WORKDIR /usr/src/denokv
RUN apt-get update && apt-get install -y git curl unzip
ARG DENOKV_VERSION=0.13.0
RUN git clone --depth 1 --branch ${DENOKV_VERSION} https://github.com/denoland/denokv.git .
RUN cargo build --release --bin denokv

# Stage 2: Final image
FROM debian:bookworm-slim AS base

# --------------------------------------------------------------------------- #
# System dependencies
# --------------------------------------------------------------------------- #
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        unzip \
        sqlite3 \
        supervisor \
        msmtp \
        msmtp-mta \
        mailutils \
        && curl -fsSL https://deno.land/x/install/install.sh | sh \
        && mv /root/.deno/bin/deno /usr/local/bin/deno \
        && rm -rf /var/lib/apt/lists/*

# Copy denokv binary from builder
COPY --from=denokv-builder /usr/src/denokv/target/release/denokv /usr/local/bin/denokv

# --------------------------------------------------------------------------- #
# Litestream – continuous SQLite replication
# --------------------------------------------------------------------------- #
ARG LITESTREAM_VERSION=v0.3.13
RUN curl -fsSL \
        "https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
        | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/litestream

# --------------------------------------------------------------------------- #
# Supercronic – cron for containers (no privilege issues, structured logging)
# --------------------------------------------------------------------------- #
ARG SUPERCRONIC_VERSION=v0.2.33
RUN curl -fsSL \
        "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
        -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic

# --------------------------------------------------------------------------- #
# Directory layout
# --------------------------------------------------------------------------- #
RUN mkdir -p \
        /data \
        /tmp/backup-check \
        /etc/litestream \
        /var/log/supervisor \
        /app/scripts \
        /app/lib

# --------------------------------------------------------------------------- #
# Configuration files (copied from build context)
# --------------------------------------------------------------------------- #
COPY config/litestream.yml       /etc/litestream/litestream.yml
COPY config/supervisord.conf     /etc/supervisor/conf.d/supervisord.conf
COPY config/msmtprc              /etc/msmtprc
COPY config/crontab              /app/crontab
COPY scripts/                    /app/scripts/
COPY lib/                        /app/lib/
RUN chmod +x /app/scripts/*.sh

# --------------------------------------------------------------------------- #
# Volumes & ports
# --------------------------------------------------------------------------- #
VOLUME ["/data"]
EXPOSE 4512

# --------------------------------------------------------------------------- #
# Entrypoint – supervisord manages all processes
# --------------------------------------------------------------------------- #
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
