<div align="center">

<img src="docs/logo.png" alt="Cyberdog" width="128" height="128">

# Cyberdog

**Your SSH servers, one beautiful window.**<br>
A fast, modern alternative to Cyberduck: SFTP explorer, built-in terminal, server-health dashboard and one-click scripts — for macOS and Windows.

![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-5b6cff)
![Languages](https://img.shields.io/badge/languages-EN%20%C2%B7%20FR%20%C2%B7%20DE%20%C2%B7%20IT-19c3d6)
![License](https://img.shields.io/badge/license-MIT-2fbf71)

**English** · [Français](README.fr.md)

<img src="docs/screenshots/hero.png" alt="Cyberdog: explorer, terminal and server health side by side" width="100%">

</div>

---

## ✨ Why Cyberdog?

| | |
|---|---|
| 📁 **A real file explorer** | Browse any server like a local folder: sortable columns (name, size, date, owner, group, permissions, type, extension), drag & drop from your desktop, right-click actions, **instant remote search**, **split view** and one-click **archive extraction**. |
| 🖥️ **Terminal included** | One click opens an SSH terminal *under* the explorer, already `cd`'d into the folder you are browsing. No more juggling windows. |
| 📈 **Server health at a glance** | Online/offline, CPU, RAM, load, disks with alerts, uptime and SSH latency. |
| ⚙️ **Services, logs & Docker** | Start/stop/restart `systemctl` services, follow `journalctl` / Nginx / app logs live (level filters, error highlighting, favorite searches), manage Docker containers (live logs, CPU/RAM, start/stop) and inspect images. |
| ⚡ **Quick actions** | Save bash scripts once, run them on one server — or on **all open servers** — with one click. |
| 🔁 **Share your setup** | Selectively export groups, servers, actions and paths to ZIP. Import configuration, **Cyberduck**, **FileZilla XML** and **WinSCP INI**. |
| 🎨 **Made to look good** | 7 themes, 4 languages, discreet scrollbars, tabs for as many servers as you like. |

---

## ⚙️ Settings

The **Settings** button beside the language selector — or **Cyberdog → Settings…** on macOS — groups language, theme, default editor and update preferences. You can also select an external configuration folder to share servers, groups, quick actions, saved paths and favorite searches while keeping personal preferences local to each computer.

Window size, position and maximized state are restored at the next launch. If a monitor is disconnected, the window returns to an available screen.

Double-clicking a file opens it in the selected editor and uploads every saved change back to the server.

---

## 📦 Install

Download the latest installer from the **[Releases page](https://github.com/pickywawa/cyberdog/releases/latest)**.

Cyberdog shows its version beside the logo and highlights new versions with an animated **New** badge. On Windows (standard installation), click it to download and install the update, then restart the app. On macOS, once the DMG has downloaded, Cyberdog offers to open it and quit automatically so you can drag the update into Applications, then reopen the app. Choose Later to keep using Cyberdog and install the downloaded DMG another time. If the DMG cannot be opened, Cyberdog stays running. The portable Windows build downloads and opens its executable.

### macOS (Apple Silicon & Intel)

1. Download `Cyberdog-<version>-mac-arm64.dmg` (Apple Silicon: M1/M2/M3/M4) or `Cyberdog-<version>-mac-x64.dmg` (Intel).
2. Open the `.dmg` and drag **Cyberdog** to **Applications**.
3. First launch: the app is not notarized yet, so macOS may block it. Either **right-click → Open → Open**, or run once:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Cyberdog.app
   ```

### Windows (10 / 11, 64-bit)

- **Installer**: `Cyberdog-Setup-<version>-x64.exe` — choose the install folder, get Start-menu and desktop shortcuts.
- **Portable**: `Cyberdog-<version>-portable-x64.exe` — no installation, run it from anywhere (USB stick, shared folder…).

> On first launch Windows SmartScreen may warn about an unrecognized publisher (the app is not code-signed yet): click **More info → Run anyway**.

Each release also ships a `SHA256SUMS.txt` so you can verify your download.

---

## 🚀 Tour

### Export and import configuration

**Export configuration** opens a category selector: groups (when present), servers, quick actions and saved paths. All categories start checked and collapsed. Expand them to select individual items, or use each category checkbox to select or clear all of its items.

The ZIP contains a `manifest.json` and `groups/`, `servers/`, `actions/` and `paths/` folders, with one JSON file per selected item. Server passwords, host fingerprints and private key files are excluded. Action scripts are exported as written.

**Import → Configuration ZIP** restores these categories together and also accepts legacy server or action ZIPs. Imports merge without overwriting existing connection credentials. Saved paths are mapped to matching servers even when their internal IDs differ. A server-specific path exported without its server requires that server to already exist at the destination; unmatched paths are skipped and counted in the result.

The import menu retains **Cyberduck** and adds SFTP sites from **FileZilla** (`sitemanager.xml` or an XML export) and **WinSCP** (INI via [Tools → Export/Backup configuration](https://winscp.net/eng/docs/config)). Third-party passwords are not imported. Transmit and SolarWinds formats are not supported yet.

Saved paths live in the version-independent user data directory. Writes are atomic, with a `paths.json.bak` copy for recovery if the primary file becomes unreadable. An unavailable external configuration directory retains its saved location and shows a message instead of silently switching directories.

### Open your servers with a double-click

Double-click a server (or press Enter on a focused server) to open it. An animated Cyberdog and opening status appear in the tab while connecting.

Add servers with a name, host, login and password (or rely on your SSH agent / key). Drag them to reorder, sort A→Z, and **import everything from Cyberduck** in one click. The welcome page walks you through the options.

Keep a long list tidy: **groups** (collapsible, remembered between launches), **favorites** (★ on a server or a whole group: they float to the top under a *Favorites* separator), a **live search** box (🔍) that filters servers and groups as you type, and **Duplicate** in the right-click menu to create a new server pre-filled from an existing one. Drag a server onto a group to move it.

<img src="docs/screenshots/groups.png" alt="Server list organized into groups and favorites" width="100%">

Right-click a server and choose **Duplicate** to open a prefilled form without creating a connection or copying its identity.

<img src="docs/screenshots/server-menu.png" alt="Server context menu with the Duplicate action" width="100%">

<img src="docs/screenshots/home.png" alt="Welcome page with import options" width="100%">

### A modern file explorer

Folders first, colored icons by file type, multi-selection (⌘/Ctrl-click, Shift-click), and a right-click menu with *Download as…, Copy name, Copy full path, Edit with…, Extract, Rename, Delete, New folder, New file*.

<img src="docs/screenshots/explorer.png" alt="File explorer" width="100%">

**Edit with…** downloads the file, opens it in VS Code, Cursor, Sublime Text, Notepad++, TextEdit… (whatever is installed) and **uploads it back every time you save**.

<img src="docs/screenshots/menu.png" alt="Context menu with Edit with submenu" width="100%">

**Saved paths**: the 🔖 button inside the path bar drops down your favorite folders (per server or for all servers) — click one to jump there. Manage them from the 🔖 button of the right-hand toolbar.

**Search the server** (🔍 or ⌘/Ctrl-F): type a few letters, get live suggestions — in the current folder or on the whole server — and jump straight to the file's parent folder with the file selected.

<img src="docs/screenshots/search.png" alt="Remote search with autocomplete" width="100%">

**Extract archives in place**: right-click a `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.7z`, `.rar`, `.gz`… and choose *Extract here* or *Extract to "name/"* — it runs on the server, nothing is downloaded.

**Split view**: the ⧉ button in the explorer toolbar splits it into **two independent explorers** (own path, history, selection, sort and search) to compare folders or work in two places at once. Drag files from one side to the other to copy them, even across folders. Click ⧉ again to merge.

<img src="docs/screenshots/split.png" alt="Split view with two explorers" width="100%">

**Drag & drop** files from your desktop to upload them (folders included), or drag files from Cyberdog to your desktop to download them.

**Everything is resizable**: drag the edge of the server list, of the right-hand panel, of the terminal or between the two explorers. Sizes are remembered.

### Permissions and ownership

Right-click a file or folder and choose **Permissions…** to see the current owner and select another account from the server. The octal mode (`0644`, `0755`…) stays synchronized with **Read / Write / Execute** checkboxes for owner, group and others. Special `setuid`, `setgid` and `sticky` bits are available too.

The file group is preserved. Changes use your SSH account’s permissions; denied ownership changes and partially applied changes are reported.

### Terminal, right where you work

The terminal opens under the explorer, starts in the current folder and stays open while you switch panels. Drag the splitter to resize it.

### Server health dashboard

Click the 📈 button in the right-hand toolbar (the terminal, health, services, logs, Docker and quick-action buttons all live there). Every 10 seconds you get:

- **Online / offline** status and the time of the last check
- **CPU, memory, swap and system load**
- **Disk space per volume** with warnings at 80 % and critical alerts at 90 %
- **Uptime, SSH latency and connection time**, plus a history of recent checks

<img src="docs/screenshots/dashboard.png" alt="Server health dashboard" width="100%">

### Process Explorer

The right-hand **Process Explorer** shows Linux processes over SSH without an agent. It refreshes every 5 seconds, with search and grouping by program, parent tree, user, systemd service or container. CPU/memory trends use observed samples for up to 5 minutes, flagging CPU spikes, memory growth, zombies and uninterruptible I/O waits.

On-demand details show listening ports, working directory and command. Local rules provide a guided diagnosis. The context menu opens logs or an SSH terminal and offers **SIGTERM / SIGKILL**, with confirmation. Available details depend on permissions; Linux `/proc` and `procps` are required, `ss` supplies ports and the systemd journal supplies logs.

Right-hand panels resize down to a minimum of **480 px**, with their width remembered between launches.

### Services

The ⚙️ button lists your `systemctl` services with their state, a search box and filters (running / failed / stopped). Start a stopped service, restart or stop a running one — `sudo` is handled for you when you are not root — or jump to its logs in one click.

<img src="docs/screenshots/services.png" alt="systemd services" width="100%">

### Live logs

The 📜 button follows your logs in real time: the **system journal** (`journalctl -f`), a **single unit**, **Nginx** error/access logs, `syslog`, `auth.log` or **any file**. Filter by text and by level, see errors and warnings **highlighted** (with counters), pause by scrolling, and keep **favorite searches** one click away.

<img src="docs/screenshots/logs.png" alt="Live system logs with highlighted errors" width="100%">

### Docker

The 📦 button lists your containers with live **CPU / RAM usage**, lets you **start, stop and restart** them, **tail their logs live** and **inspect** containers and images (ports, mounts, env, layers…). Ideal when your servers host containerized apps.

<img src="docs/screenshots/docker.png" alt="Docker containers" width="100%">
<img src="docs/screenshots/docker-logs.png" alt="Live container logs" width="100%">

### Quick actions

Save your everyday bash snippets (restart a stack, clean logs, disk report…) next to your servers. Run one on the current server, or on **every open server at once**, and read each output right in the panel. Export your actions to a zip and share them with your team.

<img src="docs/screenshots/actions.png" alt="Quick actions" width="100%">

### Themes & languages

System, Light, Dark, Midnight, Dracula, Forest and Sunset — the terminal follows. The interface is available in **English, Français, Deutsch and Italiano**.

<table>
  <tr>
    <td><img src="docs/screenshots/theme-dracula.png" alt="Dracula theme"></td>
    <td><img src="docs/screenshots/theme-forest.png" alt="Forest theme"></td>
    <td><img src="docs/screenshots/theme-sunset.png" alt="Sunset theme"></td>
  </tr>
</table>

---

## 🔒 Security & privacy

- Passwords are **encrypted with your OS keychain** (macOS Keychain / Windows DPAPI) and never leave your machine. Exports never contain passwords or host fingerprints.
- **Host keys** are pinned on first connection (trust on first use); a changed key blocks the connection until you accept it.
- `sudo` passwords are sent over the encrypted SSH channel on stdin, never on a command line.
- No telemetry, no account, no cloud: your configuration is plain JSON files on your disk.

Configuration lives in:

| | |
|---|---|
| macOS | `~/Library/Application Support/Cyberdog/` |
| Windows | `%APPDATA%\Cyberdog\` |

(`servers/` and `actions/` hold one JSON file per item, `settings.json` holds language and theme.)

---

## 🛠️ Build from source

Requirements: [Node.js](https://nodejs.org) 22+.

```sh
git clone https://github.com/pickywawa/cyberdog.git
cd cyberdog
npm install

npm start          # run the app
npm test           # unit tests
npm run dist:mac   # macOS .dmg (arm64 + x64)   — run on a Mac
npm run dist:win   # Windows installer + portable — run on Windows
```

Installers are written to `dist/`. Icons are generated from `src/assets/icon.svg` with `npm run icons` (macOS).

### Releases (CI/CD)

| Workflow | Trigger | What it does |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | every push / pull request | runs the tests on Linux and macOS |
| [`release.yml`](.github/workflows/release.yml) | tag `v*` (or manual run) | builds the macOS `.dmg` and Windows `.exe` files, then publishes a GitHub Release with checksums |

To publish a new version:

```sh
npm version patch        # or minor / major: bumps package.json and creates the v* tag
git push --follow-tags   # the pipeline builds and publishes the release
```

---

## 🧱 Tech

Electron · [ssh2](https://github.com/mscdex/ssh2) (SFTP, shell, exec) · [xterm.js](https://xtermjs.org) · plain HTML/CSS/JS (no framework, no bundler).

```
src/main.js        main process: SSH/SFTP, storage, IPC
src/renderer.js    explorer, tabs, terminal, search
src/panels.js      health dashboard, quick actions
src/ops.js         services, live logs, Docker
src/archive.js     archive detection + extraction commands
src/health.js      remote health script + parsers
src/i18n.js        translations (EN/FR/DE/IT)
```

## 📄 License

[MIT](LICENSE) © pickywawa
