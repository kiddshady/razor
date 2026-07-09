const { contextBridge, ipcRenderer } = require('electron');

// Catálogo de tools + permisos default: fuente única de verdad en ai-tools.js
// (proceso main). NO se puede require() acá: en un preload sandboxeado require()
// solo permite 'electron'. Lo traemos por IPC síncrono al cargar (el handler de
// main ya está registrado a esta altura). Si fallara, la UI cae a vacío y el main
// igual aplica sus permisos por defecto.
let toolCatalog = [];
let toolPermsDefault = {};
try {
  const res = ipcRenderer.sendSync('ai:tool-catalog');
  if (res) { toolCatalog = res.catalog || []; toolPermsDefault = res.defaults || {}; }
} catch (e) { /* noop */ }

contextBridge.exposeInMainWorld('razor', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // PTY
  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (callback) => ipcRenderer.on('pty:data', (e, { id, data }) => callback(id, data)),
    onExit: (callback) => ipcRenderer.on('pty:exit', (e, { id, exitCode }) => callback(id, exitCode)),
  },

  // AI
  ai: {
    chat: (messages, context, config) => ipcRenderer.invoke('ai:chat', { messages, context, config }),
    listModels: (config) => ipcRenderer.invoke('ai:listModels', config),
    onChunk: (callback) => ipcRenderer.on('ai:chunk', (e, chunk) => callback(chunk)),
    onTool: (callback) => ipcRenderer.on('ai:tool', (e, info) => callback(info)),
    onToolConfirm: (callback) => ipcRenderer.on('ai:tool-confirm', (e, info) => callback(info)),
    confirmTool: (cid, decision) => ipcRenderer.invoke('ai:tool-confirm-response', { cid, decision }),
    onDone: (callback) => ipcRenderer.on('ai:done', () => callback()),
    onError: (callback) => ipcRenderer.on('ai:error', (e, err) => callback(err)),
  },

  // Auto-update. check(manual): manual=true → feedback visible ("al día"/error).
  // onStatus recibe { phase, manual, version?, percent?, error? }.
  update: {
    check: (manual) => ipcRenderer.invoke('update:check', { manual: !!manual }),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (callback) => ipcRenderer.on('update:status', (e, payload) => callback(payload)),
  },

  // Catálogo de herramientas del agente y sus permisos por defecto (para la UI).
  toolCatalog,
  toolPermsDefault,

  // Platform info
  platform: process.platform,
  homeDir: process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\francisco',
});