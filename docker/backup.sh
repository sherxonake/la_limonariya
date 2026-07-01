#!/bin/sh
set -eu

# Daily pg_dump loop for the `backup` service in docker-compose.yml.
# Writes to a host bind-mount (./backups), not a named Docker volume, so a
# `docker compose down -v` or volume loss doesn't take the backups with it.
# Keeps the last KEEP_DAYS days, gzip-compressed.

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DEST=/backups

echo "backup: starting, keep=${KEEP_DAYS}d, dest=${DEST}"

while true; do
  ts=$(date -u +%Y%m%d_%H%M%S)
  out="${DEST}/limonariya_${ts}.sql.gz"
  tmp="${out}.tmp"

  if pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$tmp"; then
    mv "$tmp" "$out"
    echo "backup: ok -> ${out} ($(du -h "$out" | cut -f1))"
  else
    rm -f "$tmp"
    echo "backup: FAILED at ${ts}" >&2
  fi

  find "$DEST" -name 'limonariya_*.sql.gz' -mtime "+${KEEP_DAYS}" -delete

  sleep 86400
done
