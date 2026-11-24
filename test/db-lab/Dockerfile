# A Debian server reached over SSH, as on a VPS: PostgreSQL, MariaDB and Redis installed from the distribution,
# an "admin" account with key login and sudo, and the Docker CLI on the host's socket (sibling database containers).
FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server sudo iproute2 procps postgresql postgresql-client mariadb-server mariadb-client redis-server docker.io gzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash admin && echo 'admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/admin \
 && mkdir -p /run/sshd /home/admin/.ssh && chmod 700 /home/admin/.ssh
COPY seed /seed
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 22
CMD ["/start.sh"]
