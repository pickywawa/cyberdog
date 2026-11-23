const assert = require('assert')
const { spawnSync } = require('child_process')
const k = require('../src/kube')

// ---------- arguments ----------
assert.deepStrictEqual(k.listArgs({ kind: 'pods', context: 'prod', namespace: 'web' }), ['get', 'pods', '-o', 'json', '--request-timeout=15s', '--context', 'prod', '-n', 'web'])
assert.deepStrictEqual(k.listArgs({ kind: 'workloads' }).slice(0, 2), ['get', 'deployments,statefulsets,daemonsets'])
assert.ok(k.listArgs({ kind: 'pods' }).includes('-A'), 'no namespace: all namespaces')
assert.ok(!k.listArgs({ kind: 'nodes', namespace: 'web' }).includes('-n'), 'nodes are cluster-wide')
assert.deepStrictEqual(k.listArgs({ kind: 'events', context: 'arn:aws:eks:eu-west-1:123:cluster/main', namespace: 'kube-system' }).slice(-4), ['--context', 'arn:aws:eks:eu-west-1:123:cluster/main', '-n', 'kube-system'])
for (const bad of [{ kind: 'secrets' }, { kind: 'pods', namespace: 'Web' }, { kind: 'pods', namespace: '-A' }, { kind: 'pods', context: '--kubeconfig=/x' }, { kind: 'pods', context: 'a\nb' }])
  assert.throws(() => k.listArgs(bad), /invalid/, JSON.stringify(bad))
assert.deepStrictEqual(k.textArgs({ type: 'pod', name: 'api-7d9f', namespace: 'web', format: 'yaml' }), ['get', 'pod', 'api-7d9f', '-o', 'yaml', '--request-timeout=15s', '-n', 'web'])
assert.deepStrictEqual(k.textArgs({ type: 'node', name: 'node-1', namespace: 'ignored', format: 'describe' }), ['describe', 'node', 'node-1', '--request-timeout=15s'])
assert.throws(() => k.textArgs({ type: 'secret', name: 'x', namespace: 'web', format: 'yaml' }), /invalid type/, 'no secrets')
assert.throws(() => k.textArgs({ type: 'pod', name: 'x', namespace: 'web', format: 'json' }), /invalid format/)
assert.deepStrictEqual(k.actionArgs({ type: 'pod', name: 'api-1', namespace: 'web', action: 'delete' }), ['delete', 'pod', 'api-1', '--wait=false', '-n', 'web'])
assert.deepStrictEqual(k.actionArgs({ type: 'deployment', name: 'api', namespace: 'web', action: 'restart', context: 'prod' }), ['rollout', 'restart', 'deployment/api', '--context', 'prod', '-n', 'web'])
assert.deepStrictEqual(k.actionArgs({ type: 'statefulset', name: 'db', namespace: 'data', action: 'scale', replicas: 3 }), ['scale', 'statefulset/db', '--replicas=3', '-n', 'data'])
assert.throws(() => k.actionArgs({ type: 'daemonset', name: 'x', namespace: 'web', action: 'scale', replicas: 2 }), /invalid action/)
assert.throws(() => k.actionArgs({ type: 'deployment', name: 'x', namespace: 'web', action: 'scale', replicas: -1 }), /invalid replicas/)
assert.throws(() => k.actionArgs({ type: 'deployment', name: 'x', namespace: 'web', action: 'scale', replicas: '3' }), /invalid replicas/)
assert.throws(() => k.actionArgs({ type: 'node', name: 'n', action: 'delete' }), /invalid action/)
assert.deepStrictEqual(k.logArgs({ pod: 'api-1', container: 'app', namespace: 'web' }), ['logs', '-f', '--tail=300', '--timestamps=false', 'api-1', '-c', 'app', '-n', 'web'])
assert.deepStrictEqual(k.logArgs({ type: 'deployment', name: 'api', namespace: 'web' }).slice(4), ['deployment/api', '--all-containers', '--max-log-requests=10', '-n', 'web'])
assert.throws(() => k.logArgs({ pod: 'api-1', namespace: 'web', container: 'App_1' }), /invalid container/)

// ---------- shell command, run through a real shell with an echoing kubectl ----------
const cmd = k.execCommand({ bin: 'kubectl', context: "it's", namespace: 'web', pod: 'api-1', container: 'app' })
assert.strictEqual(cmd, "kubectl 'exec' '-it' 'api-1' '-c' 'app' '--context' 'it'\\''s' '-n' 'web' '--' 'sh' '-c' 'command -v bash >/dev/null && exec bash || exec sh'")
const echoed = spawnSync('sh', ['-c', 'kubectl() { printf "%s|" "$@"; }; ' + cmd], { encoding: 'utf8' })
assert.strictEqual(echoed.stdout, "exec|-it|api-1|-c|app|--context|it's|-n|web|--|sh|-c|command -v bash >/dev/null && exec bash || exec sh|")
assert.ok(k.execCommand({ bin: 'k3s kubectl', sudo: true, namespace: 'default', pod: 'x' }).startsWith("sudo k3s kubectl 'exec'"))
assert.throws(() => k.execCommand({ bin: 'rm -rf /;', namespace: 'web', pod: 'x' }), /invalid binary/)

// ---------- summaries ----------
const meta = (name, extra = {}) => ({ name, namespace: 'web', creationTimestamp: '2026-11-20T10:00:00Z', ...extra })
const container = (name, ready, state, restartCount = 0, lastState = {}) => ({ name, ready, state, restartCount, lastState })
const pods = k.summarize({ items: [
  { kind: 'Pod', metadata: meta('ok-1', { ownerReferences: [{ kind: 'ReplicaSet', name: 'ok-7d' }] }), spec: { nodeName: 'n1', containers: [{ name: 'app', image: 'api:1' }, { name: 'proxy', image: 'envoy' }] }, status: { phase: 'Running', podIP: '10.0.0.4', containerStatuses: [container('app', true, { running: {} }), container('proxy', true, { running: {} }, 2)] } },
  { kind: 'Pod', metadata: meta('crash-1'), spec: { containers: [{ name: 'app', image: 'api:2' }] }, status: { phase: 'Running', containerStatuses: [container('app', false, { waiting: { reason: 'CrashLoopBackOff' } }, 7, { terminated: { reason: 'OOMKilled' } })] } },
  { kind: 'Pod', metadata: meta('pending-1'), spec: { containers: [{ name: 'app' }] }, status: { phase: 'Pending', containerStatuses: [container('app', false, { waiting: { reason: 'ContainerCreating' } })] } },
  { kind: 'Pod', metadata: meta('init-1'), spec: { initContainers: [{ name: 'migrate' }, { name: 'warm' }], containers: [{ name: 'app' }] }, status: { phase: 'Pending', initContainerStatuses: [container('migrate', false, { terminated: { exitCode: 0 } }), container('warm', false, { running: {} })] } },
  { kind: 'Pod', metadata: meta('job-1'), spec: { containers: [{ name: 'job' }] }, status: { phase: 'Succeeded', containerStatuses: [container('job', false, { terminated: { reason: 'Completed', exitCode: 0 } })] } },
  { kind: 'Pod', metadata: meta('bye-1', { deletionTimestamp: '2026-11-23T10:00:00Z' }), spec: { containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [container('app', true, { running: {} })] } },
  { kind: 'Pod', metadata: meta('starting-1'), spec: { containers: [{ name: 'app' }] }, status: { phase: 'Running', containerStatuses: [container('app', false, { running: {} })] } },
  { kind: 'Secret', metadata: meta('ignored') },
] })
assert.deepStrictEqual(pods.map(p => [p.name, p.status, p.level, p.ready, p.restarts]), [
  ['crash-1', 'CrashLoopBackOff', 'crit', '0/1', 7], ['init-1', 'Init:1/2', 'warn', '0/1', 0], ['pending-1', 'ContainerCreating', 'warn', '0/1', 0], ['starting-1', 'Running', 'warn', '0/1', 0],
  ['ok-1', 'Running', 'ok', '2/2', 2], ['bye-1', 'Terminating', 'idle', '1/1', 0], ['job-1', 'Completed', 'idle', '0/1', 0]])
const ok = pods.find(p => p.name === 'ok-1')
assert.deepStrictEqual([ok.containers, ok.node, ok.ip, ok.owner, ok.created], [['app', 'proxy'], 'n1', '10.0.0.4', 'ReplicaSet/ok-7d', Date.parse('2026-11-20T10:00:00Z')])
assert.strictEqual(pods.find(p => p.name === 'crash-1').lastTerm, 'OOMKilled')
assert.strictEqual(k.pod({ metadata: meta('x'), spec: { initContainers: [{ name: 'i' }], containers: [{ name: 'a' }] }, status: { phase: 'Pending', initContainerStatuses: [container('i', false, { waiting: { reason: 'ImagePullBackOff' } })] } }).status, 'Init:ImagePullBackOff')

const w = k.summarize({ items: [
  { kind: 'Deployment', metadata: meta('api'), spec: { replicas: 3, template: { spec: { containers: [{ image: 'api:1' }] } } }, status: { readyReplicas: 3, updatedReplicas: 3 } },
  { kind: 'Deployment', metadata: meta('half'), spec: { replicas: 2, template: { spec: { containers: [] } } }, status: { readyReplicas: 1 } },
  { kind: 'StatefulSet', metadata: meta('db'), spec: { replicas: 1, template: { spec: { containers: [{ image: 'postgres:16' }] } } }, status: {} },
  { kind: 'DaemonSet', metadata: meta('agent'), spec: { template: { spec: { containers: [] } } }, status: { desiredNumberScheduled: 4, numberReady: 4 } },
  { kind: 'Deployment', metadata: meta('off'), spec: { replicas: 0, template: { spec: { containers: [] } } }, status: {} },
] })
assert.deepStrictEqual(w.map(x => [x.name, x.type, x.ready, x.level, x.scalable]), [['db', 'statefulset', '0/1', 'crit', true], ['half', 'deployment', '1/2', 'warn', true], ['agent', 'daemonset', '4/4', 'ok', false], ['api', 'deployment', '3/3', 'ok', true], ['off', 'deployment', '0/0', 'idle', true]])

const svc = k.service({ metadata: meta('web'), spec: { type: 'LoadBalancer', clusterIP: '10.43.0.10', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP', nodePort: 31000 }, { port: 443, targetPort: 443 }] }, status: { loadBalancer: { ingress: [{ ip: '203.0.113.5' }] } } })
assert.deepStrictEqual([svc.svcType, svc.ports, svc.external, svc.level], ['LoadBalancer', ['80→8080:31000/TCP', '443/TCP'], ['203.0.113.5'], 'ok'])
assert.strictEqual(k.service({ metadata: meta('lb'), spec: { type: 'LoadBalancer', ports: [] }, status: {} }).level, 'warn', 'pending external IP')
const ing = k.ingress({ metadata: meta('site'), spec: { ingressClassName: 'traefik', tls: [{}], rules: [{ host: 'example.com', http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }, { path: '/api', backend: { service: { name: 'api', port: { name: 'http' } } } }] } }] }, status: { loadBalancer: { ingress: [{ hostname: 'lb.example.net' }] } } })
assert.deepStrictEqual([ing.hosts, ing.routes, ing.address, ing.className, ing.tls], [['example.com'], ['example.com/ → web:80', 'example.com/api → api:http'], ['lb.example.net'], 'traefik', true])
const nodes = [k.node({ metadata: { name: 'cp', labels: { 'node-role.kubernetes.io/control-plane': '' }, creationTimestamp: '2026-01-01T00:00:00Z' }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'DiskPressure', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.31.2+k3s1', osImage: 'Ubuntu 24.04' }, capacity: { cpu: '4', memory: '8048000Ki' }, addresses: [{ type: 'InternalIP', address: '192.168.1.10' }] } }),
  k.node({ metadata: { name: 'w1', labels: {} }, spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } })]
assert.deepStrictEqual(nodes.map(n => [n.status, n.level, n.roles, n.pressure]), [['Ready', 'warn', ['control-plane'], ['DiskPressure']], ['NotReady,SchedulingDisabled', 'crit', ['worker'], []]])
assert.deepStrictEqual([nodes[0].version, nodes[0].ip, nodes[0].cpu], ['v1.31.2+k3s1', '192.168.1.10', '4'])
const ev = k.summarize({ items: [
  { kind: 'Event', metadata: meta('a'), type: 'Normal', reason: 'Pulled', message: 'ok', involvedObject: { kind: 'Pod', name: 'api-1' }, lastTimestamp: '2026-11-23T10:00:00Z', count: 1 },
  { kind: 'Event', metadata: meta('b'), type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container\n', involvedObject: { kind: 'Pod', name: 'crash-1' }, lastTimestamp: '2026-11-23T11:00:00Z', count: 12 },
  { kind: 'Event', metadata: meta('c', { creationTimestamp: '2026-11-23T09:00:00Z' }), type: 'Normal', reason: 'ScalingReplicaSet', note: 'Scaled up', regarding: { kind: 'Deployment', name: 'api' }, eventTime: null },
] })
assert.deepStrictEqual(ev.map(e => [e.reason, e.level, e.object, e.objectType, e.count, e.message]), [['BackOff', 'warn', 'Pod/crash-1', 'pod', 12, 'Back-off restarting failed container'], ['Pulled', 'idle', 'Pod/api-1', 'pod', 1, 'ok'], ['ScalingReplicaSet', 'idle', 'Deployment/api', 'deployment', 1, 'Scaled up']], 'latest first')

// ---------- kubectl top ----------
assert.deepStrictEqual([...k.parseTop('web   api-1   12m   64Mi\nkube-system  coredns-1  3m  20Mi\n', null)], [['web/api-1', { cpu: 12, memory: 64 * 1024 ** 2 }], ['kube-system/coredns-1', { cpu: 3, memory: 20 * 1024 ** 2 }]])
assert.deepStrictEqual([...k.parseTop('api-1  1   1Gi\nerror: Metrics API not available\n', 'web')], [['web/api-1', { cpu: 1000, memory: 1024 ** 3 }]])
assert.strictEqual(k.parseTop('error: Metrics API not available', 'web').size, 0)

// ---------- errors ----------
assert.strictEqual(k.errorKind('sh: 1: kubectl: not found'), 'missing')
assert.strictEqual(k.errorKind('error: error loading config file "/etc/rancher/k3s/k3s.yaml": open /etc/rancher/k3s/k3s.yaml: permission denied'), 'permission')
assert.strictEqual(k.errorKind('Insufficient permissions to access MicroK8s.'), 'permission')
assert.strictEqual(k.errorKind('The connection to the server localhost:8080 was refused - did you specify the right host or port?'), 'unreachable')
assert.strictEqual(k.errorKind('Error from server (Forbidden): pods is forbidden: User "dev" cannot list resource "pods"'), 'forbidden')
assert.strictEqual(k.errorKind('Error from server (NotFound): pods "x" not found'), null)
console.log('ok')
