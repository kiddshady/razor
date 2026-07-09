# RAZOR 🔪

Terminal AI embebido con estética cyberpunk. Electron + xterm.js + node-pty + agente AI.

## Setup

```bash
cd C:\tools\razor
npm install
npm start
```

## Estructura

```
razor/
├── package.json
├── src/
│   ├── main.js          # Proceso principal (Electron + PTY)
│   ├── preload.js       # Bridge seguro contextIsolation
│   └── renderer/
│       ├── index.html   # UI
│       ├── styles.css   # Estética cyberpunk neon razor
│       └── renderer.js  # Lógica del renderer (tabs, terminal, AI, palette)
└── mockup/              # Diseño original de Claude Design (referencia)
```

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+T` | Nueva tab |
| `Ctrl+W` | Cerrar tab |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+A` | Toggle AI dock |
| `Ctrl+L` | Limpiar terminal |

## Estado

**v0.1.0 — MVP**
- ✅ Terminal PTY real (node-pty + xterm.js)
- ✅ Tabs múltiples
- ✅ Window controls (frameless)
- ✅ Sidebar
- ✅ Status bar
- ✅ Command palette
- ✅ Error detection (patrones básicos)
- ✅ AI dock (stub — pendiente conectar al agent loop)
- ⬜ AI agent loop real
- ⬜ Autocomplete inteligente
- ⬜ Fix mode (aplicar fix con Enter)
- ⬜ Themes
- ⬜ Sessions persistentes
- ⬜ Snippets
- ⬜ History

## Diseño

Basado en el mockup **1a** de Claude Design. Ver `mockup/RAZOR.dc.html`.