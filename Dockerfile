FROM debian:bookworm-slim AS base

# --------------------------------------------------------------------------- #
# System dependencies
# --------------------------------------------------------------------------- #
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        sqlite3 \
        supervisor \
        msmtp \
        msmtp-mta \
        mailutils \
        && rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------------------- #
# denokv  – latest release binary for linux/amd64
# --------------------------------------------------------------------------- #
ARG DENOKV_VERSION=0.7.0
RUN curl -fsSL \
        "https://github.com/denoland/denokv/releases/download/${DENOKV_VERSION}/denokv-x86_64-unknown-linux-gnu.zip" \
        -o /tmp/denokv.zip \
    && unzip /tmp/denokv.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/denokv \
    && rm /tmp/denokv.zip

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
        /app/scripts

# --------------------------------------------------------------------------- #
# Configuration files (copied from build context)
# --------------------------------------------------------------------------- #
COPY config/litestream.yml       /etc/litestream/litestream.yml
COPY config/supervisord.conf     /etc/supervisor/conf.d/supervisord.conf
COPY config/msmtprc              /etc/msmtprc
COPY config/crontab              /app/crontab
COPY scripts/                    /app/scripts/
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
