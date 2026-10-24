#!/bin/sh
# MeatyBeatz container entrypoint — permission-safe edition.
#
# WHY THIS IS DIFFERENT FROM THE STOCK RELEASE
# --------------------------------------------
# The stock image runs everything as root, so the first start creates
# /data (and meatybeatz.db inside it) owned by root. On a plain local box
# that is invisible; on many hosts it breaks: filesystems with ACLs
# (e.g. ZFS/NFSv4), or Docker running containers in user namespaces, where
# "root" inside the container is not real root on the host — so the folder
# ends up owned by a uid you cannot easily control, and manually fixing
# permissions often does not stick (the next container start
# recreates/rewrites files as its own uid).
#
# This entrypoint removes root from the picture entirely:
#   * The app runs as MEATYBEATZ_UID:MEATYBEATZ_GID (default 1000:1000).
#     Every file it creates in /data is owned by THAT uid — never root.
#   * If the container starts as root, we do ONE preparation pass (create +
#     chown the data folder while we still can) and then drop privileges for
#     good. Set MEATYBEATZ_UID=0 to keep the old always-root behaviour.
#   * If the data folder cannot be made writable by the app user, we fail
#     fast with a message that tells you exactly which uid/gid to set on the
#     host side (host-side owner of the mounted folder) — no silent corruption.
#   * `docker run ... meatybeatz-invidious diag` prints a permission report
#     without starting the services.
#
# The three services started below (unchanged from the stock release):
#   1. static-server.js  : serves the web app            (MEATYBEATZ_WEB_PORT,  default 8097)
#   2. db-server.js      : SQLite disk database          (MEATYBEATZ_DB_PORT,   default 8198)
#   3. local-proxy.js    : optional YouTube direct proxy (MEATYBEATZ_PROXY_PORT,default 8199)

set -eu

APP_UID="${MEATYBEATZ_UID:-1000}"
APP_GID="${MEATYBEATZ_GID:-1000}"
DATA_DIR="$(dirname "${MEATYBEATZ_DB_FILE:-/data/meatybeatz.db}")"

# ---------- small helpers ----------------------------------------------------

is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

describe_data_dir() {
  if [ -e "$DATA_DIR" ]; then
    stat -c 'owner uid=%u gid=%g mode=%a' "$DATA_DIR" 2>/dev/null || ls -ldn "$DATA_DIR"
  else
    echo "does not exist yet (parent: $(dirname "$DATA_DIR"))"
  fi
}

permission_help() {
  # $1 = the uid that needs write access (as seen from inside the container)
  cat >&2 <<EOF

How to fix it on the host:
  1. Make the mounted data folder owned by / writable for uid $1:
       chown -R $1:$(id -g) <the folder you mapped to /data>
     (run this as a privileged user, via SSH if your host is remote).
  2. Or set MEATYBEATZ_UID / MEATYBEATZ_GID in docker-compose.yml to the uids
     that ALREADY own the folder (check with: ls -ln <folder> on the host).
  3. If your Docker runs containers inside a user namespace (some NAS systems
      and newer distro setups do), "uid $1" inside the container may map to a
      DIFFERENT uid on the host. Find that host uid by looking at the owner of
      any file the container created (ls -ln <folder> after a start attempt),
      and chown the folder to THAT uid instead.
  4. Last resort: set MEATYBEATZ_UID=0 to run as root again (old behaviour).

EOF
}

# ---------- validation --------------------------------------------------------

is_number "$APP_UID" || { echo "MeatyBeatz: MEATYBEATZ_UID must be a number (got: '$APP_UID')" >&2; exit 1; }
is_number "$APP_GID" || { echo "MeatyBeatz: MEATYBEATZ_GID must be a number (got: '$APP_GID')" >&2; exit 1; }

# ---------- diag mode ----------------------------------------------------------

if [ "${1:-}" = "diag" ]; then
  echo "MeatyBeatz permission report"
  EFF_NAME="$(getent passwd "$(id -u)" | cut -d: -f1)"
  echo "  effective uid/gid : $(id -u):$(id -g)${EFF_NAME:+ ($EFF_NAME)}"
  echo "  requested uid/gid : ${APP_UID}:${APP_GID}"
  echo "  data dir          : $DATA_DIR"
  echo "  data dir state    : $(describe_data_dir)"
  if [ -d "$DATA_DIR" ]; then
    probe="$DATA_DIR/.meatybeatz-diag.$$"
    # Subshell: a failed redirect on the `:` builtin would otherwise abort the
    # whole script (busybox ash treats it as fatal) instead of taking the else.
    if ( : > "$probe" ) 2>/dev/null; then
      rm -f "$probe"
      echo "  writable by us?   : YES — the container can use this folder as-is."
      exit 0
    else
      echo "  writable by us?   : NO — see the fix steps below."
      permission_help "$(id -u)"
      exit 1
    fi
  else
    if mkdir -p "$DATA_DIR" 2>/dev/null; then
      echo "  created $DATA_DIR as uid $(id -u) — it is now usable."
      exit 0
    else
      echo "  writable by us?   : NO (folder missing and cannot be created) — see fix steps below."
      permission_help "$(id -u)"
      exit 1
    fi
  fi
fi

# ---------- root preparation pass (only when we actually have real root) ------

if [ "$(id -u)" = "0" ] && [ "$APP_UID" != "0" ]; then
  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR" || { echo "MeatyBeatz: cannot create $DATA_DIR" >&2; exit 1; }
  fi
  # Make the folder — and anything already in it (e.g. a root-owned DB left by
  # the old stock image) — owned by the app user. Best effort: under user-
  # namespace setups this can legitimately fail, in which case the writability
  # check below reports exactly what to change on the host.
  chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true
  chmod 755 "$DATA_DIR" 2>/dev/null || true

  # Make sure a user with that uid exists so we can su to it. The node image
  # already ships uid 1000 ("node"); for any other uid we create one on the fly.
  # (getent — not `id` — understands numeric uids.)
  if ! getent passwd "$APP_UID" >/dev/null 2>&1; then
    # Ensure the group exists, then resolve its NAME — busybox adduser -G
    # takes a group name, not a numeric gid.
    getent group "$APP_GID" >/dev/null 2>&1 || addgroup -g "$APP_GID" meatybeatz 2>/dev/null || true
    APP_GROUP="$(getent group "$APP_GID" | cut -d: -f1)"
    [ -n "$APP_GROUP" ] || { echo "MeatyBeatz: cannot resolve a group for gid $APP_GID" >&2; exit 1; }
    adduser -D -H -u "$APP_UID" -G "$APP_GROUP" -s /bin/sh meatybeatz 2>/dev/null \
      || { echo "MeatyBeatz: cannot create user for uid $APP_UID (is that uid already taken?)" >&2; exit 1; }
  fi
  APP_USER="$(getent passwd "$APP_UID" | cut -d: -f1)"
  [ -n "$APP_USER" ] || { echo "MeatyBeatz: cannot resolve a user for uid $APP_UID" >&2; exit 1; }

  echo "MeatyBeatz: data dir $DATA_DIR prepared — dropping root -> $APP_USER (uid $APP_UID, gid $APP_GID)"
  # Re-exec this same script as the app user. The entrypoint takes no runtime
  # arguments of its own ("diag" is handled above), and all MEATYBEATZ_* env
  # vars are preserved across su.
  exec su -s /bin/sh "$APP_USER" -c "exec \"$0\""
fi

# ---------- running as the app user from here on (no root needed) -------------

if [ ! -d "$DATA_DIR" ]; then
  if mkdir -p "$DATA_DIR" 2>/dev/null; then :; else
    echo "MeatyBeatz: cannot create data folder $DATA_DIR as uid $(id -u)." >&2
    echo "  current state of $DATA_DIR: $(describe_data_dir)" >&2
    permission_help "$(id -u)"
    exit 1
  fi
fi

probe="$DATA_DIR/.meatybeatz-write-test.$$"
# Subshell: a failed redirect on the `:` builtin would otherwise abort the
# whole script (busybox ash treats it as fatal) instead of taking the else.
if ! ( : > "$probe" ) 2>/dev/null; then
  echo "MeatyBeatz: data folder $DATA_DIR is not writable by uid $(id -u)." >&2
  echo "  current state of $DATA_DIR: $(describe_data_dir)" >&2
  permission_help "$(id -u)"
  exit 1
fi
rm -f "$probe"

# An existing database (e.g. from the old root-based image) must be openable.
DB_FILE="${MEATYBEATZ_DB_FILE:-/data/meatybeatz.db}"
if [ -e "$DB_FILE" ] && [ ! -w "$DB_FILE" ]; then
  echo "MeatyBeatz: existing database $DB_FILE is not writable by uid $(id -u)." >&2
  echo "  current state of $DB_FILE: $(stat -c 'owner uid=%u gid=%g mode=%a' "$DB_FILE" 2>/dev/null || ls -ln "$DB_FILE")" >&2
  permission_help "$(id -u)"
  exit 1
fi

echo "MeatyBeatz: running as uid $(id -u) gid $(id -g); $DATA_DIR is writable."

trap 'kill 0' TERM INT

node server/static-server.js &
node server/db-server.js &
node server/local-proxy.js &

wait
