const { X509Certificate } = require('crypto')
const quote = s => `'${s.replace(/'/g, `'\\''`)}'`
const ROOTS = ['/etc/letsencrypt/live', '/etc/nginx', '/etc/apache2', '/etc/pki/tls/certs', '/usr/local/etc/nginx']
function scanScript(custom = '') {
  if (typeof custom !== 'string' || custom && (!custom.startsWith('/') || /[\0\r\n]/.test(custom)) || custom.length > 4096) throw new Error('Invalid certificate directory')
  const roots = custom ? [custom] : ROOTS
  return `
command -v openssl >/dev/null || { echo 'OpenSSL is required'; exit 1; }
PATH="$PATH:/snap/bin"
if command -v certbot >/dev/null; then printf 'CERTBOT:1\\0'; else printf 'CERTBOT:0\\0'; fi
for root in ${roots.map(quote).join(' ')}; do
 [ -d "$root" ] || continue
 find -L "$root" -maxdepth 5 -type f \\( -name '*.pem' -o -name '*.crt' -o -name '*.cer' \\) 2>/dev/null
done | head -n 301 | (n=0; while IFS= read -r file; do
 if [ "$n" -ge 300 ]; then printf '%s\\0%s\\0' '@@LIMIT' '300'; break; fi
 n=$((n + 1))
 der=$(openssl x509 -in "$file" -outform DER 2>/dev/null | openssl base64 -A)
 if [ -z "$der" ]; then der=$(openssl x509 -inform DER -in "$file" -outform DER 2>/dev/null | openssl base64 -A); fi
 [ -n "$der" ] || continue
 printf '%s\\0%s\\0' "$file" "$der"
done)
exit 0
`
}
function parseScan(output) {
  const fields = output.split('\0'), meta = fields.shift()
  if (!/^CERTBOT:[01]$/.test(meta)) throw new Error('Invalid certificate scan response')
  const certificates = new Map()
  let truncated = false
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = fields[i], raw = fields[i + 1]
    if (file === '@@LIMIT') { truncated = true; continue }
    if (!file || !raw) continue
    try {
      const c = new X509Certificate(Buffer.from(raw, 'base64'))
      let cert = certificates.get(c.fingerprint256)
      if (!cert) {
        cert = { fingerprint: c.fingerprint256, subject: c.subject, isCA: c.ca, issuer: c.issuer, domains: c.subjectAltName || '', validFrom: new Date(c.validFrom).getTime(), validTo: new Date(c.validTo).getTime(), paths: [] }
        certificates.set(c.fingerprint256, cert)
      }
      cert.paths.push(file)
      cert.certName ||= file.match(/^\/etc\/letsencrypt\/live\/([A-Za-z0-9_.-]+)\/(?:cert|fullchain)\.pem$/)?.[1]
    } catch {} // a disappearing or malformed file must not hide the other certificates
  }
  return { certbot: meta === 'CERTBOT:1', truncated, certificates: [...certificates.values()], scannedAt: Date.now() }
}
function status(cert, days = 30, now = Date.now()) {
  const remaining = Math.ceil((cert.validTo - now) / 86400000)
  return { days: remaining, level: cert.validTo <= now ? 'crit' : cert.validFrom > now || remaining <= days ? 'warn' : 'ok', expired: cert.validTo <= now, notYetValid: cert.validFrom > now }
}
function renewScript(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,250}$/.test(name)) throw new Error('Invalid Certbot certificate name')
  return `PATH="$PATH:/snap/bin"; export PATH; certbot renew --cert-name ${quote(name)} --non-interactive`
}
module.exports = { ROOTS, scanScript, parseScan, status, renewScript }
