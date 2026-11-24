#!/bin/sh
# Database lab for Cyberdog: `test/db-lab/lab.sh up` (prints the SSH port), `lab.sh down`.
# Key: test/db-lab/.key (generated, git-ignored). Needs Docker.
set -e
cd "$(dirname "$0")"
case "$1" in
  up)
    [ -f .key ] || ssh-keygen -q -t ed25519 -N '' -f .key -C cyberdog-db-lab
    cp .key.pub seed/authorized_keys
    docker network inspect cyberdog-db-lab >/dev/null 2>&1 || docker network create cyberdog-db-lab >/dev/null
    docker build -q -t cyberdog-db-lab . >/dev/null
    docker ps -a --format '{{.Names}}' | grep -qx cyberdog-db-lab || docker run -d --name cyberdog-db-lab --network cyberdog-db-lab -p 127.0.0.1::22 -v /var/run/docker.sock:/var/run/docker.sock cyberdog-db-lab >/dev/null
    docker start cyberdog-db-lab >/dev/null
    # sibling containers, seen by the server's docker CLI
    docker ps -a --format '{{.Names}}' | grep -qx lab-analytics-pg || docker run -d --name lab-analytics-pg --network cyberdog-db-lab -e POSTGRES_USER=analytics -e POSTGRES_PASSWORD=analytics-pw -e POSTGRES_DB=analytics -v "$PWD/seed/analytics.sql:/docker-entrypoint-initdb.d/1.sql:ro" postgres:16-alpine >/dev/null
    docker ps -a --format '{{.Names}}' | grep -qx lab-cache-redis || docker run -d --name lab-cache-redis --network cyberdog-db-lab redis:7-alpine redis-server --requirepass cache-pw >/dev/null
    docker ps -a --format '{{.Names}}' | grep -qx lab-legacy-mysql || docker run -d --name lab-legacy-mysql --network cyberdog-db-lab -e MYSQL_ROOT_PASSWORD=legacy-root-pw -e MYSQL_DATABASE=legacy mysql:8.4 >/dev/null
    docker start lab-analytics-pg lab-cache-redis lab-legacy-mysql >/dev/null
    docker port cyberdog-db-lab 22 | head -1 | sed 's/.*://'
    ;;
  down) docker rm -f cyberdog-db-lab lab-analytics-pg lab-cache-redis lab-legacy-mysql >/dev/null 2>&1 || true; docker network rm cyberdog-db-lab >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|down"; exit 1 ;;
esac
