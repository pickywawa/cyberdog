'use strict'
let language = 'fr'
try { language = localStorage.getItem('cyberdog.site.language') === 'en' ? 'en' : 'fr' } catch {}
const views = {
  explorer: { image:'assets/explorer.png', fr:'Fichiers distants, recherche et permissions : un explorateur pensé pour le quotidien.', en:'Remote files, search and permissions: an explorer built for everyday work.' },
  dashboard: { image:'assets/dashboard.png', fr:'CPU, mémoire, stockage et alertes : prenez le pouls de votre serveur.', en:'CPU, memory, storage and alerts: take your server’s pulse.' },
  docker: { image:'assets/docker-logs.png', fr:'Conteneurs et logs en direct, sans quitter votre espace de travail.', en:'Containers and live logs, without leaving your workspace.' }
}
let selectedView = 'explorer', demoPaused = matchMedia('(prefers-reduced-motion: reduce)').matches
function updateView(key) {
  selectedView = key
  const view = views[key], image = document.querySelector('#gallery-image')
  image.src = view.image; image.alt = view[language]
  document.querySelector('#gallery-open').dataset.image = view.image
  document.querySelector('#gallery-caption').textContent = view[language]
  document.querySelector('#view-panel').setAttribute('aria-labelledby', 'tab-' + key)
  document.querySelectorAll('[data-view]').forEach(button => { const on = button.dataset.view === key; button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1 })
}
function translate() {
  document.documentElement.lang = language
  document.querySelectorAll('[data-fr][data-en]').forEach(el => { el.textContent = el.dataset[language].replaceAll('\\n', '\n') })
  document.title = language === 'fr' ? 'Cyberdog — Vos serveurs, une seule fenêtre.' : 'Cyberdog — Your servers, one window.'
  const langButton = document.querySelector('#language')
  langButton.textContent = language === 'fr' ? 'EN' : 'FR'
  langButton.setAttribute('aria-label', language === 'fr' ? 'Switch to English' : 'Passer en français')
  document.querySelector('#demo-toggle').textContent = demoPaused ? (language === 'fr' ? 'Relancer' : 'Resume') : 'Pause'
  document.querySelector('#demo-toggle').setAttribute('aria-pressed', String(demoPaused))
  updateView(selectedView)
}
document.querySelector('#language').addEventListener('click', () => { language = language === 'fr' ? 'en' : 'fr'; try { localStorage.setItem('cyberdog.site.language', language) } catch {} translate() })
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => updateView(button.dataset.view))
  button.addEventListener('keydown', event => {
    const buttons = [...document.querySelectorAll('[data-view]')], index = buttons.indexOf(button)
    let target
    if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length]
    if (event.key === 'ArrowLeft') target = buttons[(index + buttons.length - 1) % buttons.length]
    if (event.key === 'Home') target = buttons[0]
    if (event.key === 'End') target = buttons.at(-1)
    if (target) { event.preventDefault(); target.focus(); updateView(target.dataset.view) }
  })
})
const lightbox = document.querySelector('#lightbox')
document.querySelectorAll('.screenshot-open').forEach(button => button.addEventListener('click', () => {
  const image = document.querySelector('#lightbox-image'); image.src = button.dataset.image; image.alt = button.querySelector('img').alt
  lightbox.showModal()
}))
document.querySelector('#lightbox-close').addEventListener('click', () => lightbox.close())
lightbox.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); lightbox.close() } })
lightbox.addEventListener('click', event => { if (event.target === lightbox) lightbox.close() })
document.querySelector('#year').textContent = new Date().getFullYear()
document.querySelector('#demo-toggle').addEventListener('click', () => { demoPaused = !demoPaused; translate() })
let progress = 52
setInterval(() => {
  if (demoPaused || document.hidden) return
  progress = progress >= 100 ? 0 : progress + .3
  document.querySelector('#demo-progress').style.width = progress + '%'
  document.querySelector('#demo-label').textContent = (48 * progress / 100).toFixed(1) + ' MB / 48 MB'
}, 150)
if ('IntersectionObserver' in window) {
  document.documentElement.classList.add('js')
  const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target) } }), { threshold:.08 })
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el))
}
translate()
// Keep the site usable when GitHub's API is blocked or rate limited: links already point to Releases.
fetch('https://api.github.com/repos/pickywawa/cyberdog/releases/latest', { signal:AbortSignal.timeout(8000), credentials:'omit' }).then(response => { if (!response.ok) throw new Error('Release unavailable'); return response.json() }).then(release => {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) return
  const version = document.querySelector('#version'); version.textContent = release.tag_name + ' · GitHub Releases ↗'
  document.querySelectorAll('[data-asset]').forEach(link => {
    const type = link.dataset.asset
    const asset = release.assets.find(a => type === 'setup' ? /^Cyberdog-Setup-.*\.exe$/.test(a.name) : type === 'portable' ? /portable-x64\.exe$/.test(a.name) : a.name.endsWith(type))
    if (asset?.browser_download_url?.startsWith('https://github.com/pickywawa/cyberdog/releases/download/')) link.href = asset.browser_download_url
  })
}).catch(() => {})
