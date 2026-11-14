#!/usr/bin/env python3
"""Generates the static comparison pages (English at the site root, French under fr/) and the sitemap.
Run from the repository root: python3 tools/build-compare-pages.py"""
import html, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from compare_data import PRODUCTS, CHECKED

BASE = 'https://pickywawa.github.io/cyberdog/'
SITE = os.path.join(os.path.dirname(__file__), '..', 'site')
GH = 'https://github.com/pickywawa/cyberdog'
LANGS = ('en', 'fr')
HUB = {'en': 'alternatives.html', 'fr': 'alternatives.html'}
e = html.escape

UI = {
 'en': {'lang_name': 'English', 'home': 'Home', 'alts': 'Alternatives', 'features': 'Features', 'download': 'Download ↓', 'switch': 'FR', 'switch_label': 'Lire en français',
        'vs': 'CYBERDOG VS', 'cta': 'Download Cyberdog ↓', 'cta2': 'Source code ↗', 'fine': 'macOS, Windows & Linux · Free · MIT',
        'choose_us': 'Choose Cyberdog if…', 'choose_them': 'Stay with {n} if…', 'table_h': 'Feature by feature', 'table_cap': 'Cyberdog compared with {n}',
        'feature': 'Feature', 'note': 'Based on public documentation, checked {d}. Products evolve: if something is out of date, please open an issue on GitHub.',
        'shot_h': 'What Cyberdog looks like', 'shot_alt': 'Cyberdog: SFTP explorer, terminal and server health side by side', 'shot_cap': 'File explorer, terminal and server health in one window.',
        'faq_h': 'Questions', 'try_h': 'Try Cyberdog', 'try_p': 'Free, open source, no account needed. Your passwords stay on your computer.', 'also': 'Other comparisons',
        'disc': 'Cyberduck, Termius and WinSCP are trademarks of their respective owners. Cyberdog is an independent project and is not affiliated with or endorsed by them.',
        'src': 'Source code', 'support': 'Support', 'privacy': 'Privacy', 'dl_link': './?lang=en#download', 'home_link': './?lang=en', 'feat_link': './?lang=en#features'},
 'fr': {'lang_name': 'Français', 'home': 'Accueil', 'alts': 'Alternatives', 'features': 'Fonctionnalités', 'download': 'Télécharger ↓', 'switch': 'EN', 'switch_label': 'Read in English',
        'vs': 'CYBERDOG CONTRE', 'cta': 'Télécharger Cyberdog ↓', 'cta2': 'Code source ↗', 'fine': 'macOS, Windows & Linux · Gratuit · MIT',
        'choose_us': 'Choisissez Cyberdog si…', 'choose_them': 'Restez avec {n} si…', 'table_h': 'Fonction par fonction', 'table_cap': 'Cyberdog comparé à {n}',
        'feature': 'Fonction', 'note': 'D’après la documentation publique, vérifiée en {d}. Les produits évoluent : si une information est périmée, ouvrez une issue sur GitHub.',
        'shot_h': 'Cyberdog en images', 'shot_alt': 'Cyberdog : explorateur SFTP, terminal et santé du serveur côte à côte', 'shot_cap': 'Explorateur de fichiers, terminal et santé du serveur dans une seule fenêtre.',
        'faq_h': 'Questions', 'try_h': 'Essayez Cyberdog', 'try_p': 'Gratuit, open source, sans compte. Vos mots de passe restent sur votre ordinateur.', 'also': 'Autres comparatifs',
        'disc': 'Cyberduck, Termius et WinSCP sont des marques de leurs propriétaires respectifs. Cyberdog est un projet indépendant, sans lien avec eux et non approuvé par eux.',
        'src': 'Code source', 'support': 'Support', 'privacy': 'Confidentialité', 'dl_link': '../?lang=fr#download', 'home_link': '../?lang=fr', 'feat_link': '../?lang=fr#features'},
}
HUBTXT = {
 'en': {'title': 'Cyberdog compared with Cyberduck, Termius and WinSCP | Cyberdog',
        'desc': 'How Cyberdog, a free open-source SSH and SFTP client with a terminal and server health dashboard, compares with Cyberduck, Termius and WinSCP.',
        'h1': 'Cyberdog compared with other SSH and SFTP clients',
        'intro': 'Cyberdog is a free, open-source desktop app that puts an SFTP file explorer, a terminal and a server health dashboard in one window, on macOS, Windows and Linux. These pages explain, feature by feature and without hiding where the others are stronger, how it compares with the tools you may use today.',
        'read': 'Read the comparison →',
        'blurb': {'cyberduck': 'The popular file browser for SFTP, FTP and cloud storage.', 'termius': 'The cross-device SSH client with sync and team plans.', 'winscp': 'The reference SFTP client on Windows, strong at scripting.'},
        'why_h': 'What Cyberdog is built for',
        'why': ['One window for files, terminal and server health, over a single SSH connection with no agent on the server.',
                'More than SFTP: FTP/FTPS, S3-compatible storage, Azure, WebDAV, SMB, Dropbox, OneDrive and Google Drive.',
                'Bastions with a route test, teams with roles and history, ten secret-vault connectors.',
                'Free and open source (MIT). Passwords stay in your system keychain. No telemetry.']},
 'fr': {'title': 'Cyberdog comparé à Cyberduck, Termius et WinSCP | Cyberdog',
        'desc': 'Comment Cyberdog, client SSH et SFTP gratuit et open source avec terminal et tableau de santé des serveurs, se compare à Cyberduck, Termius et WinSCP.',
        'h1': 'Cyberdog comparé aux autres clients SSH et SFTP',
        'intro': 'Cyberdog est une application de bureau gratuite et open source qui réunit un explorateur de fichiers SFTP, un terminal et un tableau de santé des serveurs dans une seule fenêtre, sur macOS, Windows et Linux. Ces pages expliquent, fonction par fonction et sans cacher les points forts des autres, comment il se compare aux outils que vous utilisez peut-être aujourd’hui.',
        'read': 'Lire le comparatif →',
        'blurb': {'cyberduck': 'Le navigateur de fichiers populaire pour SFTP, FTP et le stockage cloud.', 'termius': 'Le client SSH multi-appareils avec synchronisation et offres d’équipe.', 'winscp': 'Le client SFTP de référence sous Windows, fort en scripts.'},
        'why_h': 'Ce pour quoi Cyberdog est conçu',
        'why': ['Une fenêtre pour les fichiers, le terminal et la santé des serveurs, sur une seule connexion SSH, sans agent sur le serveur.',
                'Plus que SFTP : FTP/FTPS, stockage compatible S3, Azure, WebDAV, SMB, Dropbox, OneDrive et Google Drive.',
                'Bastions avec test du trajet, équipes avec rôles et historique, dix connecteurs de coffres de secrets.',
                'Gratuit et open source (MIT). Les mots de passe restent dans le trousseau du système. Aucune télémétrie.']},
}

def url(lang, name):
    return BASE + ('fr/' if lang == 'fr' else '') + name

def head(lang, title, desc, name, other_name, extra=''):
    other = 'fr' if lang == 'en' else 'en'
    cur = url(lang, name); alt = url(other, other_name)
    rel = '../' if lang == 'fr' else ''
    return f'''<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="theme-color" content="#0b1020">
<link rel="canonical" href="{cur}">
<link rel="alternate" hreflang="{lang}" href="{cur}"><link rel="alternate" hreflang="{other}" href="{alt}"><link rel="alternate" hreflang="x-default" href="{url('en', other_name if lang == 'fr' else name)}">
<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="{cur}"><meta property="og:image" content="{BASE}assets/hero.png">
<link rel="icon" href="{rel}assets/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="{rel}style.css">
{extra}</head>
<body class="compare-page">
'''

def header(lang, other_name):
    u = UI[lang]; rel = '../' if lang == 'fr' else ''
    other = 'fr' if lang == 'en' else 'en'
    other_href = ('fr/' if other == 'fr' else '../') + other_name
    return f'''<header class="header"><a class="brand" href="{u['home_link']}" aria-label="Cyberdog"><img src="{rel}assets/icon.svg" width="34" height="34" alt="">Cyberdog<span class="brand-dot"></span></a><nav aria-label="Navigation"><a href="{u['feat_link']}">{u['features']}</a><a href="{HUB[lang]}">{u['alts']}</a><a href="{GH}" target="_blank" rel="noopener">GitHub ↗</a></nav><div class="nav-end"><a class="lang-link" href="{other_href}" hreflang="{other}" lang="{other}" aria-label="{u['switch_label']}">{u['switch']}</a><a class="button small" href="{u['dl_link']}">{u['download']}</a></div></header>
'''

def footer(lang):
    u = UI[lang]; rel = '../' if lang == 'fr' else ''
    return f'''<footer class="wrap footer"><a class="brand" href="{u['home_link']}"><img src="{rel}assets/icon.svg" width="25" height="25" alt="">Cyberdog</a><span>© 2026 pickywawa · MIT</span><div><a href="{GH}">{u['src']} ↗</a><a href="{GH}/issues">{u['support']} ↗</a><a href="{rel}privacy.html">{u['privacy']}</a><a href="{HUB[lang]}">{u['alts']}</a></div></footer>
</body></html>
'''

def others(lang, current):
    items = []
    for key, p in PRODUCTS.items():
        if key == current: continue
        items.append(f'<a class="chip-link" href="{p["slug"][lang]}">Cyberdog vs {e(p["name"])}</a>')
    return ''.join(items)

def product_page(lang, key):
    p = PRODUCTS[key]; u = UI[lang]; rel = '../' if lang == 'fr' else ''
    other = 'fr' if lang == 'en' else 'en'
    name = p['name']
    faq = p['faq'][lang]
    ld = {'@context': 'https://schema.org', '@type': 'FAQPage',
          'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in faq]}
    extra = '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False) + '</script>\n'
    out = head(lang, p['title'][lang], p['description'][lang], p['slug'][lang], p['slug'][other], extra) + header(lang, p['slug'][other])
    rows = ''.join(f'<tr><th scope="row">{e(r[0][lang])}</th><td>{e(r[1][lang])}</td><td class="us">{e(r[2][lang])}</td></tr>' for r in p['rows'])
    out += f'''<main id="main">
<section class="wrap compare-hero"><nav class="breadcrumb" aria-label="Breadcrumb"><a href="{u['home_link']}">{u['home']}</a><span>›</span><a href="{HUB[lang]}">{u['alts']}</a><span>›</span><span>{e(name)}</span></nav>
<p class="eyebrow"><span class="live-dot"></span>{u['vs']} {e(name.upper())}</p>
<h1>{e(p['h1'][lang])}</h1>
<p class="intro">{e(p['intro'][lang])}</p>
<div class="hero-actions"><a class="button" href="{u['dl_link']}">{u['cta']}</a><a class="text-link" href="{GH}" target="_blank" rel="noopener">{u['cta2']}</a></div>
<p class="fine">{u['fine']}</p></section>
<section class="wrap section tight"><div class="choose-grid">
<article class="choose-card us"><h2>{u['choose_us']}</h2><ul>{''.join(f'<li>{e(x)}</li>' for x in p['choose_us'][lang])}</ul></article>
<article class="choose-card"><h2>{u['choose_them'].format(n=e(name))}</h2><ul>{''.join(f'<li>{e(x)}</li>' for x in p['choose_them'][lang])}</ul></article>
</div></section>
<section class="wrap section tight"><div class="section-heading"><h2>{u['table_h']}</h2></div>
<div class="table-scroll" tabindex="0" role="region" aria-label="{u['table_cap'].format(n=e(name))}"><table class="compare-table"><caption class="sr-only">{u['table_cap'].format(n=e(name))}</caption><thead><tr><th scope="col">{u['feature']}</th><th scope="col">{e(name)}</th><th scope="col" class="us">Cyberdog</th></tr></thead><tbody>{rows}</tbody></table></div>
<p class="table-note">{u['note'].format(d=CHECKED[lang])}</p></section>
<section class="wrap section tight"><div class="section-heading"><h2>{u['shot_h']}</h2></div><figure class="app-frame compare-shot"><img src="{rel}assets/hero.png" width="1600" height="1000" alt="{e(u['shot_alt'])}" loading="lazy"><figcaption class="frame-caption"><span>{u['shot_cap']}</span></figcaption></figure></section>
<section class="wrap section tight prose"><h2>{e(p['moving_h'][lang])}</h2><p>{e(p['moving'][lang])}</p></section>
<section class="wrap section tight faq"><div class="section-heading"><h2>{u['faq_h']}</h2></div>{''.join(f'<details><summary>{e(q)}</summary><p>{e(a)}</p></details>' for q, a in faq)}</section>
<section class="wrap section tight try"><h2>{u['try_h']}</h2><p>{u['try_p']}</p><div class="hero-actions"><a class="button" href="{u['dl_link']}">{u['cta']}</a></div><p class="also"><span>{u['also']}:</span> {others(lang, key)}</p><p class="disclaimer">{u['disc']}</p></section>
</main>
''' + footer(lang)
    return out

def hub_page(lang):
    t = HUBTXT[lang]; u = UI[lang]; rel = '../' if lang == 'fr' else ''
    other = 'fr' if lang == 'en' else 'en'
    cards = ''.join(f'<article class="feature"><h3>Cyberdog vs {e(p["name"])}</h3><p>{e(t["blurb"][k])}</p><a class="text-link" href="{p["slug"][lang]}">{t["read"]}</a></article>' for k, p in PRODUCTS.items())
    out = head(lang, t['title'], t['desc'], HUB[lang], HUB[other]) + header(lang, HUB[other])
    out += f'''<main id="main">
<section class="wrap compare-hero"><nav class="breadcrumb" aria-label="Breadcrumb"><a href="{u['home_link']}">{u['home']}</a><span>›</span><span>{u['alts']}</span></nav>
<p class="eyebrow"><span class="live-dot"></span>CYBERDOG</p><h1>{e(t['h1'])}</h1><p class="intro">{e(t['intro'])}</p>
<div class="hero-actions"><a class="button" href="{u['dl_link']}">{u['cta']}</a><a class="text-link" href="{GH}" target="_blank" rel="noopener">{u['cta2']}</a></div><p class="fine">{u['fine']}</p></section>
<section class="wrap section tight"><div class="feature-grid">{cards}</div></section>
<section class="wrap section tight prose"><h2>{e(t['why_h'])}</h2><ul>{''.join(f'<li>{e(x)}</li>' for x in t['why'])}</ul><p class="disclaimer">{u['disc']}</p></section>
</main>
''' + footer(lang)
    return out

def write(path, text):
    full = os.path.join(SITE, path); os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, 'w', encoding='utf-8').write(text)

def main():
    urls = [BASE]
    for lang in LANGS:
        pre = 'fr/' if lang == 'fr' else ''
        write(pre + HUB[lang], hub_page(lang)); urls.append(url(lang, HUB[lang]))
        for key, p in PRODUCTS.items():
            write(pre + p['slug'][lang], product_page(lang, key)); urls.append(url(lang, p['slug'][lang]))
    # sitemap with hreflang alternates for the paired pages
    pairs = {url('en', HUB['en']): url('fr', HUB['fr']), url('fr', HUB['fr']): url('en', HUB['en'])}
    for p in PRODUCTS.values():
        a, b = url('en', p['slug']['en']), url('fr', p['slug']['fr']); pairs[a] = b; pairs[b] = a
    body = []
    for u_ in urls:
        alt = ''
        if u_ in pairs:
            la = 'fr' if '/fr/' in u_ else 'en'; lb = 'en' if la == 'fr' else 'fr'
            alt = f'<xhtml:link rel="alternate" hreflang="{la}" href="{u_}"/><xhtml:link rel="alternate" hreflang="{lb}" href="{pairs[u_]}"/>'
        body.append(f'<url><loc>{u_}</loc>{alt}</url>')
    write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' + ''.join(body) + '</urlset>\n')
    print('wrote', len(urls) - 1, 'pages + sitemap')

if __name__ == '__main__':
    main()
