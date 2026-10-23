// Résumés lisibles de `docker inspect` (image ou conteneur). Pur : testable sans Docker.
const human = n => {
  let i = 0
  while (n >= 1024 && i < 4) { n /= 1024; i++ }
  return (i ? n.toFixed(1) : n) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]
}

// Retourne [[libellé, valeur | [valeurs]], ...] en omettant les champs vides.
function summarize(kind, raw) {
  const j = Array.isArray(raw) ? raw[0] : raw
  const cfg = j.Config || {}
  const rows = []
  const add = (k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push([k, v]) }
  const keys = o => Object.keys(o || {})

  if (kind === 'image') {
    add('Id', (j.Id || '').replace('sha256:', '').slice(0, 12))
    add('Tags', j.RepoTags)
    add('Created', j.Created)
    add('Size', typeof j.Size === 'number' ? human(j.Size) : '')
    add('Platform', [j.Os, j.Architecture].filter(Boolean).join('/'))
    add('Layers', j.RootFS?.Layers?.length ? String(j.RootFS.Layers.length) : '')
  } else {
    add('Name', (j.Name || '').replace(/^\//, ''))
    add('Image', cfg.Image)
    add('State', j.State?.Status)
    add('Created', j.Created)
    add('Started', j.State?.StartedAt && !j.State.StartedAt.startsWith('0001') ? j.State.StartedAt : '')
    add('Restart policy', j.HostConfig?.RestartPolicy?.Name)
    add('Restarts', j.RestartCount ? String(j.RestartCount) : '')
    add('Ports', keys(j.NetworkSettings?.Ports).map(p => `${p} → ${(j.NetworkSettings.Ports[p] || []).map(b => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ') || '—'}`))
    add('Mounts', (j.Mounts || []).map(m => `${m.Source} → ${m.Destination}${m.RW === false ? ' (ro)' : ''}`))
    add('Networks', keys(j.NetworkSettings?.Networks).map(n => `${n}: ${j.NetworkSettings.Networks[n].IPAddress || '—'}`))
  }
  add('Entrypoint', cfg.Entrypoint)
  add('Cmd', cfg.Cmd)
  add('Working dir', cfg.WorkingDir)
  add('User', cfg.User)
  if (kind === 'image') add('Exposed ports', keys(cfg.ExposedPorts))
  add('Env', cfg.Env)
  add('Labels', keys(cfg.Labels).map(k => `${k}=${cfg.Labels[k]}`))
  return rows
}

module.exports = { summarize, human }
