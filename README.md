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
│   ├── main.js          # Proceso principal (Electron + PTY + IA)
│   ├── ai-tools.js      # Tools del agente (filesystem + ejecución de comandos)
│   ├── preload.js       # Bridge seguro contextIsolation
│   ├── shell/           # Init de shell (OSC 7 para reportar la cwd al agente)
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

## Configurar la IA

RAZOR **no incluye ninguna API key** — cada quien trae la suya. Abrí el dock de IA
(`Ctrl+Shift+A`), entrá a **Settings** y configurá:

- **Provider**: Ollama (Cloud o local), OpenAI, Anthropic, OpenRouter, Groq, o
  Custom (cualquier endpoint compatible con OpenAI).
- **API Key**: pegá la tuya. Se guarda local; no sale del equipo salvo hacia el
  proveedor que elijas.
- **Model**: el modelo del proveedor (ej. `glm-5.2`, `gpt-4o`, `claude-sonnet-5`…).

El agente puede leer archivos y ejecutar comandos en tu máquina mediante *tools*. Las
de ejecución (`shell_exec` / `cmd_exec`) son peligrosas por defecto y **piden
confirmación** antes de correr — ajustable en **Settings → Tool permissions**
(Off / Ask / Allow por cada tool).

Alternativamente, para el provider por defecto (Ollama) podés usar variables de
entorno en vez del panel:

```bash
OLLAMA_API_KEY=tu-key
OLLAMA_HOST=https://ollama.com/v1   # opcional
OLLAMA_MODEL=glm-5.2                # opcional
```

## Estado

**v0.1.0 — MVP**
- ✅ Terminal PTY real (node-pty + xterm.js)
- ✅ Tabs múltiples
- ✅ Window controls (frameless)
- ✅ Sidebar
- ✅ Status bar
- ✅ Command palette
- ✅ Error detection (patrones básicos)
- ✅ AI dock — chat multi-provider (OpenAI-compatible + Anthropic)
- ✅ Agent loop con tools: lectura de archivos y ejecución de comandos con permisos/confirmación
- ⬜ Autocomplete inteligente
- ⬜ Fix mode (aplicar fix con Enter)
- ⬜ Themes
- ⬜ Sessions persistentes
- ⬜ Snippets
- ⬜ History

## Diseño

Basado en el mockup **1a** de Claude Design. Ver `mockup/RAZOR.dc.html`.
