// Scripts exécutés sur le serveur (via `sh -s`) et parseurs de leur sortie. Aucun accès Electron ici : testable seul.

// PROC est surchargeable pour les tests (faux /proc).
const HEALTH_SCRIPT = `
P=\${PROC:-/proc}
echo "HOST=$(hostname 2>/dev/null)"
echo "KERNEL=$(uname -sr 2>/dev/null)"
echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
echo "UPTIME=$(cut -d. -f1 $P/uptime 2>/dev/null)"
echo "LOAD=$(cut -d' ' -f1-3 $P/loadavg 2>/dev/null)"
echo "CORES=$(grep -c '^processor' $P/cpuinfo 2>/dev/null)"
read -r _ u1 n1 s1 i1 w1 q1 sq1 _ < $P/stat
sleep 0.5 2>/dev/null || sleep 1
read -r _ u2 n2 s2 i2 w2 q2 sq2 _ < $P/stat
D=$(( (u2+n2+s2+i2+w2+q2+sq2) - (u1+n1+s1+i1+w1+q1+sq1) ))
I=$(( (i2+w2) - (i1+w1) ))
if [ "$D" -gt 0 ]; then echo "CPU=$(( 100 * (D - I) / D ))"; fi
awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} /^MemFree/{f=$2} /^Buffers/{b=$2} /^Cached/{c=$2} /^SwapTotal/{st=$2} /^SwapFree/{sf=$2} END{if(a=="")a=f+b+c; print "MEM=" t "|" a "|" st "|" sf}' $P/meminfo 2>/dev/null
df -P -k 2>/dev/null | awk 'NR>1 {m=$6; for(i=7;i<=NF;i++) m=m " " $i; print "DISK=" $1 "|" $2 "|" $3 "|" $4 "|" $5 "|" m}'
`

function parseHealth(out) {
  const r = { disks: [] }
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i < 1) continue
    const k = line.slice(0, i)
    const v = line.slice(i + 1).trim()
    if (k === 'HOST') r.hostname = v
    else if (k === 'KERNEL') r.kernel = v
    else if (k === 'OS') r.os = v
    else if (k === 'UPTIME' && v) r.uptime = +v
    else if (k === 'LOAD' && v) r.load = v.split(' ').map(Number)
    else if (k === 'CORES' && +v) r.cores = +v
    else if (k === 'CPU') r.cpu = +v
    else if (k === 'MEM') {
      const [total, avail, swapTotal, swapFree] = v.split('|').map(x => (+x || 0) * 1024)
      if (total) r.mem = { total, used: total - avail, swapTotal, swapUsed: swapTotal - swapFree }
    } else if (k === 'DISK') {
      const [fs, size, used, avail, pct, mount] = v.split('|')
      // seulement les vrais volumes (/dev/..., NFS host:/path), pas tmpfs/devtmpfs/overlay
      if (!/^\/|:/.test(fs) || +size <= 0) continue
      r.disks.push({ fs, size: +size * 1024, used: +used * 1024, avail: +avail * 1024, pct: parseInt(pct, 10) || 0, mount })
    }
  }
  return r
}

// systemctl list-units --type=service --all --no-legend --plain
const SERVICES_CMD = 'systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null'

function parseServices(out) {
  const list = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/)
    if (!m || m[2] === 'not-found') continue
    list.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], desc: m[5] })
  }
  return list
}

// Sécurité : le nom d'unité finit dans une commande shell, on le restreint strictement.
const UNIT_RE = /^[\w@:.\\-]+\.service$/
const SVC_ACTIONS = ['start', 'stop', 'restart']

module.exports = { HEALTH_SCRIPT, parseHealth, SERVICES_CMD, parseServices, UNIT_RE, SVC_ACTIONS }
