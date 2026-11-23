// Kubernetes over SSH with the server's kubectl (or k3s / microk8s kubectl). Pure: main builds every kubectl argument
// list from here, the renderer uses the same summaries. Summaries follow `kubectl get` (pod status, READY, RESTARTS…).
;(function () {
  const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/ // DNS-1123 object / namespace names
  const CONTAINER = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
  const CONTEXT = /^[^\0\r\n-][^\0\r\n]{0,252}$/ // any context name: passed as one quoted argument
  const KINDS = { pods: ['pods'], workloads: ['deployments', 'statefulsets', 'daemonsets'], services: ['services'], ingresses: ['ingresses'], nodes: ['nodes'], events: ['events'] }
  const SINGULAR = { Pod: 'pod', Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset', Service: 'service', Ingress: 'ingress', Node: 'node' }
  const CLUSTER = new Set(['nodes'])
  const BINARIES = ['kubectl', 'k3s kubectl', 'microk8s kubectl', '/snap/bin/microk8s kubectl', '/usr/local/bin/k3s kubectl']

  const check = (re, v, what) => { if (typeof v !== 'string' || !re.test(v)) throw new Error('invalid ' + what); return v }
  const scope = ({ context, namespace }, clusterWide = false) => [
    ...(context ? ['--context', check(CONTEXT, context, 'context')] : []),
    ...(clusterWide ? [] : namespace ? ['-n', check(NAME, namespace, 'namespace')] : ['-A']),
  ]

  // ---------- kubectl arguments ----------
  function listArgs(q) {
    const kinds = KINDS[q.kind]
    if (!kinds) throw new Error('invalid kind')
    return ['get', kinds.join(','), '-o', 'json', '--request-timeout=15s', ...scope(q, CLUSTER.has(q.kind))]
  }
  const topArgs = q => ['top', 'pods', '--no-headers', '--request-timeout=10s', ...scope(q)]
  const target = q => {
    const kind = check(/^(pod|deployment|statefulset|daemonset|service|ingress|node)$/, q.type, 'type')
    return { kind, name: check(NAME, q.name, 'name'), args: scope({ context: q.context, namespace: kind === 'node' ? null : check(NAME, q.namespace, 'namespace') }, kind === 'node') }
  }
  function textArgs(q) {
    const { kind, name, args } = target(q)
    if (q.format === 'yaml') return ['get', kind, name, '-o', 'yaml', '--request-timeout=15s', ...args]
    if (q.format === 'describe') return ['describe', kind, name, '--request-timeout=15s', ...args]
    throw new Error('invalid format')
  }
  function actionArgs(q) {
    const { kind, name, args } = target(q)
    if (q.action === 'delete' && kind === 'pod') return ['delete', 'pod', name, '--wait=false', ...args]
    if (q.action === 'restart' && /^(deployment|statefulset|daemonset)$/.test(kind)) return ['rollout', 'restart', `${kind}/${name}`, ...args]
    if (q.action === 'scale' && /^(deployment|statefulset)$/.test(kind)) {
      if (!Number.isSafeInteger(q.replicas) || q.replicas < 0 || q.replicas > 1000) throw new Error('invalid replicas')
      return ['scale', `${kind}/${name}`, `--replicas=${q.replicas}`, ...args]
    }
    throw new Error('invalid action')
  }
  // live logs of a pod (one container) or of a workload (kubectl picks one of its pods)
  function logArgs(q) {
    const args = ['logs', '-f', '--tail=300', '--timestamps=false']
    if (q.type && q.type !== 'pod') { const { kind, name, args: s } = target(q); return [...args, `${kind}/${name}`, '--all-containers', '--max-log-requests=10', ...s] }
    const s = scope({ context: q.context, namespace: check(NAME, q.namespace, 'namespace') })
    return [...args, check(NAME, q.pod, 'pod'), ...(q.container ? ['-c', check(CONTAINER, q.container, 'container')] : []), ...s]
  }
  const contextsArgs = () => ['config', 'get-contexts', '-o', 'name']
  const currentArgs = () => ['config', 'current-context']
  const namespacesArgs = q => ['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}', '--request-timeout=10s', ...scope(q, true)]

  // ---------- summaries ----------
  const ms = s => (s ? Date.parse(s) || null : null)
  const levelOfReason = r => /CrashLoopBackOff|Error|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|OOMKilled|Failed|Evicted|Unknown|ContainerStatusUnknown/.test(r) ? 'crit'
    : /^(Running)$/.test(r) ? 'ok' : /^(Completed|Succeeded|Terminating)$/.test(r) ? 'idle' : 'warn'

  function pod(p) {
    const st = p.status || {}, spec = p.spec || {}, cs = st.containerStatuses || []
    let reason = st.reason || st.phase || 'Unknown'
    const init = (st.initContainerStatuses || []).find(c => !(c.state?.terminated?.exitCode === 0))
    if (init) {
      const w = init.state?.waiting?.reason, t = init.state?.terminated
      if (w && w !== 'PodInitializing') reason = 'Init:' + w
      else if (t) reason = 'Init:' + (t.reason || 'Error')
      else reason = `Init:${(st.initContainerStatuses || []).filter(c => c.state?.terminated?.exitCode === 0).length}/${(spec.initContainers || []).length}`
    } else {
      for (const c of cs) {
        if (c.state?.waiting?.reason) reason = c.state.waiting.reason
        else if (c.state?.terminated) reason = c.state.terminated.reason || (c.state.terminated.signal ? 'Signal:' + c.state.terminated.signal : 'ExitCode:' + c.state.terminated.exitCode)
      }
    }
    if (p.metadata?.deletionTimestamp) reason = 'Terminating'
    const total = (spec.containers || []).length, ready = cs.filter(c => c.ready).length
    const lastTerm = cs.map(c => c.lastState?.terminated?.reason).find(Boolean)
    let level = levelOfReason(reason)
    if (level === 'ok' && ready < total) level = 'warn'
    return {
      kind: 'Pod', type: 'pod', name: p.metadata.name, namespace: p.metadata.namespace, created: ms(p.metadata.creationTimestamp),
      status: reason, level, ready: `${ready}/${total}`, restarts: cs.reduce((n, c) => n + (c.restartCount || 0), 0), lastTerm: lastTerm || '',
      node: spec.nodeName || '', ip: st.podIP || '', containers: (spec.containers || []).map(c => c.name), images: (spec.containers || []).map(c => c.image),
      owner: p.metadata.ownerReferences?.[0] ? `${p.metadata.ownerReferences[0].kind}/${p.metadata.ownerReferences[0].name}` : '',
    }
  }
  function workload(w) {
    const st = w.status || {}, kind = w.kind
    const desired = kind === 'DaemonSet' ? st.desiredNumberScheduled || 0 : w.spec?.replicas ?? 1
    const ready = kind === 'DaemonSet' ? st.numberReady || 0 : st.readyReplicas || 0
    const updated = kind === 'DaemonSet' ? st.updatedNumberScheduled || 0 : st.updatedReplicas || 0
    const level = ready >= desired ? (desired ? 'ok' : 'idle') : ready === 0 ? 'crit' : 'warn'
    return { kind, type: SINGULAR[kind], name: w.metadata.name, namespace: w.metadata.namespace, created: ms(w.metadata.creationTimestamp), ready: `${ready}/${desired}`, desired, updated, level,
      images: (w.spec?.template?.spec?.containers || []).map(c => c.image), scalable: kind !== 'DaemonSet' }
  }
  function service(s) {
    const spec = s.spec || {}
    const ext = [...(s.status?.loadBalancer?.ingress || []).map(i => i.ip || i.hostname), ...(spec.externalIPs || [])].filter(Boolean)
    return { kind: 'Service', type: 'service', name: s.metadata.name, namespace: s.metadata.namespace, created: ms(s.metadata.creationTimestamp), level: spec.type === 'LoadBalancer' && !ext.length ? 'warn' : 'ok',
      svcType: spec.type || 'ClusterIP', clusterIP: spec.clusterIP || '', external: ext,
      ports: (spec.ports || []).map(p => `${p.port}${p.targetPort != null && String(p.targetPort) !== String(p.port) ? '→' + p.targetPort : ''}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`) }
  }
  function ingress(i) {
    const spec = i.spec || {}, routes = []
    for (const r of spec.rules || []) for (const p of r.http?.paths || []) {
      const b = p.backend?.service
      routes.push(`${r.host || '*'}${p.path || '/'} → ${b ? `${b.name}:${b.port?.number ?? b.port?.name ?? ''}` : p.backend?.serviceName ? `${p.backend.serviceName}:${p.backend.servicePort}` : '?'}`)
    }
    const address = (i.status?.loadBalancer?.ingress || []).map(x => x.ip || x.hostname).filter(Boolean)
    return { kind: 'Ingress', type: 'ingress', name: i.metadata.name, namespace: i.metadata.namespace, created: ms(i.metadata.creationTimestamp), level: address.length ? 'ok' : 'warn',
      hosts: [...new Set((spec.rules || []).map(r => r.host).filter(Boolean))], routes, address, className: spec.ingressClassName || i.metadata.annotations?.['kubernetes.io/ingress.class'] || '', tls: !!(spec.tls || []).length }
  }
  function node(n) {
    const ready = (n.status?.conditions || []).find(c => c.type === 'Ready')
    const pressure = (n.status?.conditions || []).filter(c => c.type !== 'Ready' && c.status === 'True').map(c => c.type)
    const roles = Object.keys(n.metadata.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1]).filter(Boolean)
    const info = n.status?.nodeInfo || {}, cap = n.status?.capacity || {}
    const status = ready?.status === 'True' ? 'Ready' : 'NotReady'
    return { kind: 'Node', type: 'node', name: n.metadata.name, namespace: '', created: ms(n.metadata.creationTimestamp), status: status + (n.spec?.unschedulable ? ',SchedulingDisabled' : ''),
      level: status !== 'Ready' ? 'crit' : pressure.length || n.spec?.unschedulable ? 'warn' : 'ok', pressure, roles: roles.length ? roles : ['worker'],
      version: info.kubeletVersion || '', os: info.osImage || '', cpu: cap.cpu || '', memory: cap.memory || '', ip: (n.status?.addresses || []).find(a => a.type === 'InternalIP')?.address || '' }
  }
  function event(e) {
    const o = e.involvedObject || e.regarding || {}
    const last = ms(e.lastTimestamp) || ms(e.eventTime) || ms(e.series?.lastObservedTime) || ms(e.metadata?.creationTimestamp)
    return { kind: 'Event', type: 'event', name: e.metadata.name, namespace: e.metadata.namespace, created: last, last, level: e.type === 'Warning' ? 'warn' : 'idle',
      eventType: e.type || 'Normal', reason: e.reason || '', message: (e.message || e.note || '').trim(), object: `${o.kind || '?'}/${o.name || '?'}`,
      objectType: SINGULAR[o.kind] || null, objectName: o.name || '', count: e.count || e.series?.count || 1 }
  }
  const BY_KIND = { Pod: pod, Deployment: workload, StatefulSet: workload, DaemonSet: workload, Service: service, Ingress: ingress, Node: node, Event: event }
  function summarize(json) {
    const items = (json?.items || []).map(x => BY_KIND[x.kind]?.(x)).filter(Boolean)
    const LV = { crit: 0, warn: 1, ok: 2, idle: 3 }
    return items.sort((a, b) => a.kind === 'Event' ? (b.last || 0) - (a.last || 0) : LV[a.level] - LV[b.level] || (a.namespace || '').localeCompare(b.namespace || '') || a.name.localeCompare(b.name))
  }

  // `kubectl top pods --no-headers` (with -A, the namespace comes first) → Map "ns/name" → { cpu (millicores), memory (bytes) }
  const UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9 }
  const bytes = s => { const m = String(s).match(/^(\d+(?:\.\d+)?)([KMGT]i?)?$/); return m ? Math.round(Number(m[1]) * (UNITS[m[2]] || 1)) : null }
  const millicores = s => { const m = String(s).match(/^(\d+(?:\.\d+)?)(m|n|u)?$/); return m ? Number(m[1]) * ({ m: 1, n: 1e-6, u: 1e-3 }[m[2]] ?? 1000) : null }
  function parseTop(out, namespace) {
    const map = new Map()
    for (const line of String(out).split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 3 || /^(error|W\d{4}|E\d{4})/i.test(f[0])) continue
      const [ns, name] = f.length >= 4 ? [f[0], f[1]] : [namespace, f[0]]
      const cpu = millicores(f[f.length - 2]), memory = bytes(f[f.length - 1])
      if (cpu != null && memory != null) map.set(`${ns}/${name}`, { cpu, memory })
    }
    return map
  }

  // kubectl errors worth a clearer message
  function errorKind(out) {
    if (/command not found|not found: kubectl|kubectl: not found|No such file or directory.*kubectl/i.test(out)) return 'missing'
    if (/permission denied|Insufficient permissions to access MicroK8s|unable to read client-cert|error loading config file/i.test(out)) return 'permission'
    if (/connection to the server .* was refused|Unable to connect to the server|no configuration has been provided|current-context is not set|dial tcp/i.test(out)) return 'unreachable'
    if (/forbidden/i.test(out)) return 'forbidden'
    if (/the server doesn't have a resource type "ingresses"/i.test(out)) return 'noingress'
    return null
  }

  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
  // interactive shell in a pod, typed in the terminal (bash when present, otherwise sh)
  function execCommand({ bin = 'kubectl', sudo = false, context, namespace, pod: name, container }) {
    const args = ['exec', '-it', check(NAME, name, 'pod'), ...(container ? ['-c', check(CONTAINER, container, 'container')] : []), ...scope({ context, namespace: check(NAME, namespace, 'namespace') }), '--', 'sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh']
    if (!BINARIES.includes(bin)) throw new Error('invalid binary')
    return `${sudo ? 'sudo ' : ''}${bin} ${args.map(q).join(' ')}`
  }

  const api = { NAME, CONTEXT, KINDS, BINARIES, listArgs, topArgs, textArgs, actionArgs, logArgs, contextsArgs, currentArgs, namespacesArgs, summarize, pod, workload, service, ingress, node, event, parseTop, bytes, millicores, errorKind, execCommand, q }
  if (typeof module !== 'undefined') module.exports = api
  else window.kubeModel = api
})()
