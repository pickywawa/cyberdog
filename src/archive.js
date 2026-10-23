// Détection des archives et construction de la commande de désarchivage (exécutée sur le serveur).
// Double usage : require() côté main, <script> côté renderer (window.archive).
;(function () {
  // `ext` : suffixes reconnus ; `single` : un seul fichier compressé, pas un dossier d'archive.
  const KINDS = [
    { id: 'tar', tool: 'tar', ext: ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tgz', '.tbz2', '.tbz', '.txz', '.tzst', '.tar'], cmd: (f, t) => `tar -xf ${f} -C ${t}` },
    { id: 'zip', tool: 'unzip', ext: ['.zip', '.jar', '.war'], cmd: (f, t) => `unzip -o -q ${f} -d ${t}` },
    { id: '7z', tool: '7z', ext: ['.7z'], cmd: (f, t) => `7z x -y ${f} -o${t}` },
    { id: 'rar', tool: 'unrar', ext: ['.rar'], cmd: (f, t) => `unrar x -y ${f} ${t}/` },
    { id: 'gz', tool: 'gzip', single: true, ext: ['.gz'], cmd: (f, t, out) => `gzip -dc ${f} > ${out}` },
    { id: 'bz2', tool: 'bzip2', single: true, ext: ['.bz2'], cmd: (f, t, out) => `bzip2 -dc ${f} > ${out}` },
    { id: 'xz', tool: 'xz', single: true, ext: ['.xz'], cmd: (f, t, out) => `xz -dc ${f} > ${out}` },
  ]

  const match = name => {
    const n = name.toLowerCase()
    for (const kind of KINDS) {
      const ext = kind.ext.find(e => n.endsWith(e) && n.length > e.length)
      if (ext) return { kind, ext }
    }
    return null
  }

  const kind = name => match(name)?.kind ?? null
  // nom du dossier de destination : le nom de l'archive sans son extension
  const folderName = name => { const m = match(name); return m ? name.slice(0, name.length - m.ext.length) : name }

  // `q` : fonction de quotation shell fournie par l'appelant ; file/target : chemins distants absolus.
  function command(name, file, target, q) {
    const m = match(name)
    if (!m) return null
    const k = m.kind
    const out = k.single ? q(`${target}/${folderName(name)}`) : ''
    return `command -v ${k.tool} >/dev/null 2>&1 || { echo "MISSING:${k.tool}"; exit 127; }\nmkdir -p ${q(target)} && ${k.cmd(q(file), q(target), out)}`
  }

  const api = { kind, folderName, command }
  if (typeof module !== 'undefined') module.exports = api
  else window.archive = api
})()
