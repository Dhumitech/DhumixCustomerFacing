#!/bin/sh
set -eu
# PostgreSQL executes this only when creating an empty named volume. There is
# no migration replay or restoration over an existing database.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --quiet --single-transaction \
  --file /restore/roles.private.sql --file /restore/schema.private.sql --file /restore/data.private.sql
