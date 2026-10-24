# MeatyBeatz — permission-safe Docker release (any Linux distro; also runs
# via Docker Desktop on Windows/macOS).
# Same app as meatybeatz-release, but permission-safe by design:
#   * never needs root at runtime — runs as MEATYBEATZ_UID:MEATYBEATZ_GID
#     (default 1000:1000), so every file it creates in /data is owned by that
#     uid, NEVER root. Root-owned files in a bind-mounted data folder are the
#     classic cause of permission failures — especially on hosts with
#     ACL-based filesystems (e.g. ZFS/NFSv4) or Docker running containers
#     inside user namespaces; this removes root from the picture entirely.
#   * the entrypoint prepares /data once while it can (only when started as
#     real root), then drops privileges for good — see server/docker-entrypoint.sh.
#
# One image, three zero-dependency services:
#   8097  web app          (static files from app/)
#   8198  disk database    (real SQLite file, persisted on the /data volume)
#   8199  local proxy      (optional: direct YouTube data for artist/album pages)
#
# Node >= 24 is used so the built-in node:sqlite module powers the disk DB.
FROM node:24-alpine

ENV NODE_ENV=production \
    MEATYBEATZ_WEB_HOST=0.0.0.0 \
    MEATYBEATZ_WEB_PORT=8097 \
    MEATYBEATZ_DB_HOST=0.0.0.0 \
    MEATYBEATZ_DB_PORT=8198 \
    MEATYBEATZ_DB_FILE=/data/meatybeatz.db \
    MEATYBEATZ_STATE_FILE=/data/meatybeatz-state.json \
    MEATYBEATZ_PROXY_HOST=0.0.0.0 \
    MEATYBEATZ_PROXY_PORT=8199 \
    MEATYBEATZ_UID=1000 \
    MEATYBEATZ_GID=1000

WORKDIR /app

COPY app/ ./app/
COPY server/ ./server/
# The app runs as a NON-ROOT user, so every bundled file must be readable by
# it — regardless of the permissions those files had on the build host (the
# stock release only ever worked because root bypasses read checks).
#   a+rX  = make everything world-readable; add execute to directories and to
#           files that already carry an execute bit (i.e. the entrypoint).
RUN chmod 755 server/docker-entrypoint.sh && chmod -R a+rX /app

# Library persistence — mount a volume here (docker-compose.yml does this).
# The mounted folder should be owned by MEATYBEATZ_UID:MEATYBEATZ_GID on the host.
VOLUME ["/data"]

EXPOSE 8097 8198 8199

ENTRYPOINT ["./server/docker-entrypoint.sh"]
