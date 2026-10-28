# Mio 🌙

**A world of your own.**

**[简体中文](./README.md) · English**

**[🌐 Try Mio in your browser](https://uiii77.github.io/mio-pages/)**

Mio is a personal, AI-powered virtual phone: a place to create characters, have conversations, build memories, and explore everyday interactions in a world of your own.

Rather than treating each conversation as an isolated chat, Mio brings character interactions, memories, schedules, creative tools, and other activities together in one customizable web app.

> **Work in progress:** Mio is a personal project under active development. Features may change, and some experiences depend on your browser and the external AI or media services you configure.

## ✨ Explore Mio

- **Character chats:** Create and customize characters, manage conversations, and configure supported AI services.
- **Memories and relationships:** Organize memories, relationships, and context that can support ongoing character interactions.
- **Time and everyday life:** Explore character timelines, calendars, schedules, reminders, and daily activities.
- **Creative spaces:** Try reading, journals, music, character spaces, and other interactive features.
- **Make it yours:** Personalize the interface and selected behaviors to suit your preferences.

Availability and completeness vary by feature. In particular, AI generation, voice, and online media generally require compatible external services.

## 🚀 Get started

### Use the web app

1. Open **[Mio](https://uiii77.github.io/mio-pages/)** in a supported browser.
2. Complete any initial setup shown in the app.
3. If you want AI-powered features, configure an API or service that you are authorized to use.

You don't need to install a development environment to try the published app.

### Add Mio to your home screen

Mio uses Progressive Web App (PWA) technologies. On supported mobile browsers, look for **Add to Home Screen** or **Install App** in the browser menu. The exact steps depend on your device and browser.

Some cached pages and locally saved content may be available offline. **AI requests and other online features still need network access and valid service settings.**

## 🔐 Data and privacy

Mio follows a **local-first** approach. Some personal data is stored in your browser using technologies such as IndexedDB.

Please keep in mind:

- **Local storage is not cross-device sync.** Data from different devices, browsers, or website origins is not automatically merged.
- **Clearing site data can erase your records.** Use the app's available export and backup tools before clearing browser data or making major changes.
- **External providers handle the requests you send them.** Check their privacy policies and possible costs before using AI, voice, or media integrations.
- **Keep API keys and personal backups private.** Never post them in public GitHub issues or repositories.

Mio is not a cloud account synchronization service, and not every feature works fully offline.

## 🧩 About this repository

**`mio-pages` is the public website and distribution repository for Mio**, not the complete development source repository.

Its contents include the static files required to run the published website:

```text
mio-pages/
├── .github/workflows/   # GitHub Pages publishing
└── site/                # Public web assets
    ├── index.html
    ├── js/
    ├── css/
    ├── assets/
    ├── manifest.json
    └── sw.js
```

Development, builds, tests, and internal project documentation are maintained separately in a private repository. As a result, this repository does not include instructions to build the entire project from source.

The website is published with GitHub Actions and GitHub Pages.

## 🛠️ Technology

- **Frontend:** HTML, CSS, JavaScript
- **Local storage:** IndexedDB, Dexie
- **Installable web experience:** PWA, Service Worker
- **Publishing:** GitHub Actions, GitHub Pages
- **Optional integrations:** Configurable external AI and media services

## 🌱 Development status

Mio is actively evolving. Features, UI, data structures, and setup may change between releases.

This repository primarily exists to **showcase and distribute the web app**. It is not currently a complete, contribution-ready open-source development repository.

## 🌷 Credits

Mio is a derivative project built on **UwU**, with some design and implementation ideas inspired by **SullyOS**.

Many thanks to the creators and contributors of the original projects for their work and for sharing it.

Mio is independently maintained and is **not officially affiliated** with those projects or their creators.
