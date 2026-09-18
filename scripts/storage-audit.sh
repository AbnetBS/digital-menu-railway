#!/usr/bin/env bash
# Read-only VPS/Coolify storage audit. Run on the VPS as root.
set -u
printf '\n=== Filesystem ===\n'; df -hT
printf '\n=== Largest top-level directories ===\n'; du -xhd1 / 2>/dev/null | sort -h | tail -25
printf '\n=== Docker usage (Coolify) ===\n'; if command -v docker >/dev/null; then docker system df -v; else echo 'docker not installed'; fi
printf '\n=== Journald ===\n'; journalctl --disk-usage 2>/dev/null || true
printf '\n=== Large logs ===\n'; find /var/lib/docker/containers /var/log -type f -size +100M -printf '%s %p\n' 2>/dev/null | sort -n | tail -30
printf '\n=== PostgreSQL data/WAL candidates ===\n'; find /var/lib/postgresql /var/lib/docker/volumes -type f -size +100M -printf '%s %p\n' 2>/dev/null | sort -n | tail -40
printf '\n=== Database table sizes (if DATABASE_URL is set) ===\n'
if command -v psql >/dev/null && [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT n.nspname||'.'||c.relname AS table_name, pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_size_pretty(pg_relation_size(c.oid)) AS table_data, pg_size_pretty(pg_indexes_size(c.oid)) AS indexes, c.reltuples::bigint AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY pg_total_relation_size(c.oid) DESC;"
else
  echo 'Set DATABASE_URL and install psql to inspect Postgres table sizes.'
fi
