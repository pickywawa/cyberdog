#!/bin/sh
# no systemd in a container: the services are started by hand, then sshd stays in the foreground
set -e
cp /seed/authorized_keys /home/admin/.ssh/authorized_keys && chown -R admin:admin /home/admin/.ssh && chmod 600 /home/admin/.ssh/authorized_keys
[ -S /var/run/docker.sock ] && chmod 666 /var/run/docker.sock || true
ver=$(ls /usr/lib/postgresql | head -1)
sed -i "s/^#\?logging_collector.*/logging_collector = off/" /etc/postgresql/$ver/main/postgresql.conf
pg_ctlcluster $ver main start
mkdir -p /run/mysqld /var/log/mysql && chown mysql:mysql /run/mysqld /var/log/mysql
printf '[mysqld]\nlog_error=/var/log/mysql/error.log\nbind-address=127.0.0.1\n' > /etc/mysql/mariadb.conf.d/90-lab.cnf
runuser -u mysql -- mariadbd --log-error=/var/log/mysql/error.log >/dev/null 2>&1 &
mkdir -p /var/log/redis && chown redis:redis /var/log/redis
sed -i 's/^requirepass.*//' /etc/redis/redis.conf
redis-server /etc/redis/redis.conf --daemonize yes --logfile /var/log/redis/redis-server.log
for i in $(seq 1 60); do mysqladmin ping >/dev/null 2>&1 && break; sleep 0.5; done
if [ ! -f /var/lib/lab-seeded ]; then
  su postgres -c "psql -q -f /seed/postgres.sql" && mysql < /seed/mariadb.sql && redis-cli < /seed/redis.txt >/dev/null && touch /var/lib/lab-seeded
fi
exec /usr/sbin/sshd -D -e
