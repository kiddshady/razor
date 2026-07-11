const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');

let mainWindow;
let tray = null;
let isQuitting = false;

// --- Single instance lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 848,
    minWidth: 900,
    minHeight: 600,
    maximizable: false,
    backgroundColor: '#050507',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Forward renderer console logs to main process terminal
  mainWindow.webContents.on('console-message', (e, ...args) => {
    // Electron 33+ may pass (event, details) or (event, level, message, line, sourceId)
    let level, message;
    if (args.length === 1 && typeof args[0] === 'object') {
      level = args[0].level;
      message = args[0].message;
    } else {
      level = args[0];
      message = args[1];
    }
    const tag = level === 2 ? '❌' : level === 1 ? '⚠️' : 'ℹ️';
    console.log(`${tag} [RENDERER] ${message}`);
  });

  // Log load failures
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`❌ [RENDERER] Failed to load: ${url} — ${code} ${desc}`);
  });

  // Log preload errors
  mainWindow.webContents.on('preload-error', (e, preloadPath, error) => {
    console.error(`❌ [PRELOAD] ${preloadPath}: ${error.message}`);
  });

  // Aviso al renderer cuando la ventana gana foco a nivel SO. El evento del
  // BrowserWindow capta TODOS los alt-tab / click en taskbar / restore desde tray,
  // que el 'focus' del window DOM a veces se pierde en Windows (frameless + DWM).
  // El renderer usa esto para enfocar la terminal del tab activo.
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus');
    }
  });

  // Intercept close → hide to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- Tray icon ---
function createTray() {
  const iconPath = path.join(__dirname, 'razor-tray.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show RAZOR', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('RAZOR — Terminal AI');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// --- Global hotkey: Ctrl+Alt+R → toggle show/hide ---
function registerHotkeys() {
  const ret = globalShortcut.register('CommandOrControl+Alt+R', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  if (!ret) console.error('[RAZOR] Failed to register global hotkey Ctrl+Alt+R');
}

// --- IPC: window controls ---
ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
// Maximize disabled — window stays at fixed dimensions
ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// --- IPC: terminal PTY ---
const ptyProcesses = new Map();
let ptyIdCounter = 0;

// El osc7-init.ps1 viaja embebido en app.asar, y pwsh (proceso externo) NO puede
// leer adentro del asar. Node sí: copiamos el contenido a una ruta REAL (userData)
// y devolvemos esa ruta para dot-sourcear desde ahí. Cache por proceso; null si
// falla (el terminal arranca igual, sin OSC 7). Escapamos comillas simples para PS.
let osc7ScriptPath;
function getOsc7ScriptPath() {
  if (osc7ScriptPath !== undefined) return osc7ScriptPath;
  try {
    const src = path.join(__dirname, 'shell', 'osc7-init.ps1'); // legible vía fs asar-aware
    const content = fs.readFileSync(src, 'utf8');
    const dest = path.join(app.getPath('userData'), 'osc7-init.ps1'); // FS real
    fs.writeFileSync(dest, content, 'utf8');
    osc7ScriptPath = dest;
  } catch (err) {
    console.error('[RAZOR] OSC7 script setup failed:', err.message);
    osc7ScriptPath = null;
  }
  return osc7ScriptPath;
}
const psQuote = (p) => p.replace(/'/g, "''"); // comilla simple PS = duplicarla

// Directorio de arranque de toda shell nueva. En Windows, la raíz del disco; fuera de
// Windows 'C:\' no existe, así que caemos al home. Espejo de razorAPI.defaultCwd.
const DEFAULT_CWD = process.platform === 'win32' ? 'C:\\' : os.homedir();

ipcMain.handle('pty:create', (event, opts) => {
  let pty;
  try {
    pty = require('node-pty');
    console.log('[RAZOR] node-pty loaded OK');
  } catch (err) {
    console.error('[RAZOR] node-pty FAILED to load:', err.message);
    throw new Error(`node-pty not available: ${err.message}`);
  }
  const isWin = process.platform === 'win32';
  const shell = opts.shell || (isWin ? 'pwsh.exe' : 'bash');
  // On Windows: cargamos el core-profile del usuario y LUEGO el init de RAZOR que
  // agrega OSC 7 (reporte de cwd) envolviendo el prompt. El core-profile queda
  // intacto; la lógica OSC 7 vive en el repo (src/shell/osc7-init.ps1) y se copia
  // a userData porque pwsh no puede leerla desde dentro de app.asar.
  let shellArgs = [];
  if (isWin) {
    const userProfile = 'C:\\PowerShell\\core-profile.ps1';
    const razorInit = getOsc7ScriptPath();
    const bootstrap = razorInit
      ? `. '${psQuote(userProfile)}'; . '${psQuote(razorInit)}'`
      : `. '${psQuote(userProfile)}'`;
    shellArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', bootstrap];
  }
  const id = ++ptyIdCounter;
  const ptyProc = pty.spawn(shell, shellArgs, {
    name: 'xterm-color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd || DEFAULT_CWD,
    env: process.env
  });

  ptyProcesses.set(id, ptyProc);

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
    ptyProcesses.delete(id);
  });

  return id;
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.write(data);
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.resize(cols, rows);
});

ipcMain.handle('pty:kill', (event, { id }) => {
  const proc = ptyProcesses.get(id);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(id);
  }
});

// --- IPC: AI chat (multi-provider: OpenAI-compatible + Anthropic) ---
// El proveedor / API key / modelo se configuran desde el panel Settings del
// renderer y llegan en `config`. Estos defaults definen el proveedor inicial;
// la API key SIEMPRE la trae el usuario (Settings) o la variable de entorno
// OLLAMA_API_KEY. No hay ninguna key incorporada en el código.
const DEFAULT_AI = {
  provider: 'ollama',
  baseUrl: process.env.OLLAMA_HOST || 'https://ollama.com/v1',
  model: process.env.OLLAMA_MODEL || 'glm-5.2',
  apiKey: process.env.OLLAMA_API_KEY || '',
};

// baseUrl por defecto + formato de API por proveedor. El renderer puede pisar la
// baseUrl (para endpoints self-hosted / proxy); el formato de API es fijo.
const PROVIDER_DEFAULTS = {
  ollama:     { baseUrl: 'https://ollama.com/v1',         api: 'openai' },
  openai:     { baseUrl: 'https://api.openai.com/v1',     api: 'openai' },
  anthropic:  { baseUrl: 'https://api.anthropic.com',     api: 'anthropic' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',  api: 'openai' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', api: 'openai' },
  custom:     { baseUrl: '',                              api: 'openai' },
};

// Herramientas del agente de IA. Definidas en ./ai-tools.js para poder testear la
// lógica de filesystem/exec sin arrancar Electron.
const { AI_TOOLS, OPENAI_TOOLS, TOOL_CATALOG, DEFAULT_TOOL_PERMS, executeTool } = require('./ai-tools');
const MAX_TOOL_STEPS = 6; // techo de vueltas del loop de agente por turno

// El preload está sandboxeado y no puede require() módulos locales: le pasamos el
// catálogo de tools por IPC síncrono al cargar (este handler ya está registrado
// antes de que se cree la ventana).
ipcMain.on('ai:tool-catalog', (event) => {
  event.returnValue = { catalog: TOOL_CATALOG, defaults: DEFAULT_TOOL_PERMS };
});

// Permisos efectivos por tool: default + lo que mande el renderer en la config.
function resolveToolPerms(config) {
  return { ...DEFAULT_TOOL_PERMS, ...((config && config.toolPerms) || {}) };
}

// Confirmaciones pendientes (tools en modo "ask"): el loop crea una promesa y la
// resuelve cuando el renderer responde vía ai:tool-confirm-response.
const pendingConfirms = new Map();
let confirmIdCounter = 0;
function requestConfirmation(info) {
  return new Promise((resolve) => {
    const cid = ++confirmIdCounter;
    pendingConfirms.set(cid, resolve);
    sendToRenderer('ai:tool-confirm', { cid, name: info.name, input: info.input });
  });
}
ipcMain.handle('ai:tool-confirm-response', (event, { cid, decision }) => {
  const resolve = pendingConfirms.get(cid);
  if (resolve) { pendingConfirms.delete(cid); resolve(decision === 'deny' ? 'deny' : 'allow'); }
});

function safeParseJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

function resolveAIConfig(config) {
  const c = config || {};
  const provider = c.provider || DEFAULT_AI.provider;
  const pd = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  const baseUrl = (c.baseUrl && c.baseUrl.trim()) || pd.baseUrl || DEFAULT_AI.baseUrl;
  const model = (c.model && c.model.trim()) || DEFAULT_AI.model;
  // La key viene de Settings; si no, del entorno (OLLAMA_API_KEY) solo para el
  // proveedor default. No hay ninguna key incorporada en el código.
  const apiKey = (c.apiKey && c.apiKey.trim()) || (provider === DEFAULT_AI.provider ? DEFAULT_AI.apiKey : '');
  return { provider, baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey, api: pd.api, systemPrompt: (c.systemPrompt || '').trim() };
}

const DEFAULT_SYSTEM_PROMPT = `You are RAZOR, an AI terminal assistant embedded in a cyberpunk terminal called RAZOR.
Respond concisely and technically. You are a senior developer expert in Node.js, Python, cybersecurity and systems.
You help with commands, debugging, scripting and development tasks.
Remember the earlier turns of this conversation and stay consistent with them.`;

// System prompt = persona (la custom del usuario o la default) + contexto vivo del
// terminal, que SIEMPRE se anexa para que el agente no pierda contexto aunque se
// personalice la persona.
function buildSystemPrompt(context, customPrompt) {
  const { cwd, branch, lastOutput } = context || {};
  const persona = (customPrompt && customPrompt.trim()) || DEFAULT_SYSTEM_PROMPT;
  return `${persona}

You have tools to work on the user's machine:
- read-only: read_file, list_dir, path_info (inspect files/folders; ~ is home; paths may be relative to the current directory).
- commands: shell_exec (PowerShell) and cmd_exec (cmd.exe) actually RUN commands and can modify the system.
Use the read-only tools proactively when the user refers to a file or folder ("read my profile", "what's in this dir") instead of guessing. Only use the command tools when the user clearly wants an action performed; some tools may ask the user for confirmation before running, and the user can disable tools entirely.

Current terminal context:
- Directory: ${cwd || '~'}
- Git branch: ${branch || 'none'}
- Last terminal output:
${(lastOutput || '(no recent output)').slice(-2000)}`;
}

// Envío defensivo al renderer (la ventana puede estar oculta/destruida).
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('ai:chat', async (event, { messages, context, config }) => {
  const cfg = resolveAIConfig(config);
  const systemPrompt = buildSystemPrompt(context, cfg.systemPrompt);
  const history = Array.isArray(messages) ? messages.slice() : [];
  const perms = resolveToolPerms(config);
  console.log(`[RAZOR] AI chat → provider=${cfg.provider} model=${cfg.model} api=${cfg.api}`);
  try {
    await runAgentLoop(cfg, systemPrompt, history, context, perms);
    sendToRenderer('ai:done');
  } catch (err) {
    console.error('[RAZOR] AI loop failed:', err.message);
    sendToRenderer('ai:error', err.message || String(err));
  }
});

// Loop de agente: llama al modelo; si pide herramientas, las ejecuta, le devuelve
// los resultados y vuelve a llamar; corta cuando el modelo responde sin pedir más
// tools (o al llegar al techo de vueltas). El texto final se streamea vía ai:chunk
// dentro de cada streamOnce; sólo mantenemos acá el hilo de mensajes provider-format.
// `perms` mapea tool → 'off' | 'ask' | 'allow': las 'off' no se le ofrecen al modelo
// y las 'ask' piden confirmación al usuario antes de ejecutarse.
async function runAgentLoop(cfg, systemPrompt, history, context, perms) {
  const messages = history.slice();
  // Sólo ofrecemos las tools que no están apagadas.
  const anthropicTools = AI_TOOLS.filter(t => perms[t.name] !== 'off');
  const openaiTools = OPENAI_TOOLS.filter(t => perms[t.function.name] !== 'off');

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const result = (cfg.api === 'anthropic')
      ? await streamAnthropic(cfg, systemPrompt, messages, anthropicTools)
      : await streamOpenAI(cfg, systemPrompt, messages, openaiTools);

    if (!result.toolCalls.length) return; // respuesta final ya streameada

    // El modelo pidió tools: guardamos su turno y ejecutamos (o denegamos) cada una.
    messages.push(result.assistantMessage);
    const executed = [];
    for (const call of result.toolCalls) {
      const perm = perms[call.name] || 'allow';
      if (perm === 'off') {
        // No debería pasar (no se ofreció), pero por las dudas la rechazamos.
        sendToRenderer('ai:tool', { id: call.id, name: call.name, status: 'denied' });
        executed.push({ call, out: { ok: false, content: `Tool ${call.name} is disabled by the user.` } });
        continue;
      }
      if (perm === 'ask') {
        const decision = await requestConfirmation({ name: call.name, input: call.input });
        if (decision === 'deny') {
          sendToRenderer('ai:tool', { id: call.id, name: call.name, input: call.input, status: 'denied' });
          executed.push({ call, out: { ok: false, content: `The user denied permission to run ${call.name}.` } });
          continue;
        }
      }
      sendToRenderer('ai:tool', { id: call.id, name: call.name, input: call.input, status: 'running' });
      const out = await executeTool(call.name, call.input, context);
      sendToRenderer('ai:tool', { id: call.id, name: call.name, status: out.ok ? 'done' : 'error' });
      executed.push({ call, out });
    }

    // Devolvemos los resultados en el formato que espera cada API y re-llamamos.
    if (cfg.api === 'anthropic') {
      messages.push({
        role: 'user',
        content: executed.map(({ call, out }) => ({
          type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: !out.ok,
        })),
      });
    } else {
      for (const { call, out } of executed) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content });
      }
    }
  }
  // Llegamos al techo de vueltas sin una respuesta final.
  sendToRenderer('ai:chunk', '\n\n[detenido: demasiadas llamadas a herramientas]');
}

// Request HTTP(S) con parseo de SSE por líneas. `onLine(line, finish)` procesa cada
// línea completa; `finish()` resuelve el request (idempotente). NO emite ai:done ni
// ai:error: eso lo maneja el loop, que orquesta varios requests por turno. Rechaza
// la promesa ante error HTTP/red para que el loop corte y reporte.
function streamRequest(cfg, path, headers, body, onLine) {
  const url = new URL(cfg.baseUrl + path);
  const isHttps = url.protocol === 'https:';
  const reqModule = isHttps ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };

    const req = reqModule.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => { errBody += c.toString(); });
        res.on('end', () => {
          const errMsg = `HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`;
          console.error('[RAZOR] AI request failed:', errMsg);
          reject(new Error(errMsg));
        });
        return;
      }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let nlIdx;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (line) onLine(line, finish);
          if (settled) return;
        }
      });
      res.on('end', () => {
        const line = buffer.trim();
        if (line && !settled) onLine(line, finish);
        finish();
      });
    });

    req.on('error', (err) => {
      console.error('[RAZOR] AI request failed:', err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// OpenAI-compatible (/chat/completions): Ollama, OpenAI, OpenRouter, Groq, custom.
// Streamea el texto vía ai:chunk y acumula las tool calls (que llegan troceadas por
// `index` en los deltas). Devuelve { text, toolCalls, assistantMessage } para el loop.
async function streamOpenAI(cfg, systemPrompt, history, tools) {
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    ...(tools && tools.length ? { tools } : {}),
    stream: true,
  });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`,
  };
  const acc = { text: '', calls: {} }; // calls indexado por `index` del delta
  await streamRequest(cfg, '/chat/completions', headers, body, (line, finish) => {
    if (line === 'data: [DONE]') { finish(); return; }
    if (!line.startsWith('data: ')) return;
    let json;
    try { json = JSON.parse(line.slice(6)); } catch { return; } // JSON parcial
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) { acc.text += delta.content; sendToRenderer('ai:chunk', delta.content); }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const slot = acc.calls[idx] || (acc.calls[idx] = { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
  });
  const toolCalls = Object.values(acc.calls)
    .filter(s => s.name)
    .map(s => ({ id: s.id, name: s.name, input: safeParseJson(s.args) }));
  const assistantMessage = {
    role: 'assistant',
    content: acc.text || null,
    ...(toolCalls.length ? {
      tool_calls: toolCalls.map(t => ({
        id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) },
      })),
    } : {}),
  };
  return { text: acc.text, toolCalls, assistantMessage };
}

// Anthropic (/v1/messages): system va aparte; el SSE trae content blocks (text o
// tool_use) que se arman por `index`. Devuelve la misma forma que streamOpenAI.
async function streamAnthropic(cfg, systemPrompt, history, tools) {
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: history,
    ...(tools && tools.length ? { tools } : {}),
    stream: true,
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  };
  const acc = { text: '', blocks: {}, error: null }; // blocks indexado por `index`
  await streamRequest(cfg, '/v1/messages', headers, body, (line, finish) => {
    if (!line.startsWith('data:')) return; // ignoramos las líneas `event: ...`
    const payload = line.slice(line.indexOf(':') + 1).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch { return; } // JSON parcial
    if (json.type === 'content_block_start') {
      const cb = json.content_block;
      if (cb?.type === 'tool_use') acc.blocks[json.index] = { id: cb.id, name: cb.name, args: '' };
    } else if (json.type === 'content_block_delta') {
      if (json.delta?.type === 'text_delta' && json.delta.text) {
        acc.text += json.delta.text; sendToRenderer('ai:chunk', json.delta.text);
      } else if (json.delta?.type === 'input_json_delta') {
        const b = acc.blocks[json.index]; if (b) b.args += json.delta.partial_json || '';
      }
    } else if (json.type === 'message_stop') {
      finish();
    } else if (json.type === 'error') {
      acc.error = json.error?.message || 'stream error';
      finish();
    }
  });
  if (acc.error) throw new Error(acc.error);
  const toolCalls = Object.values(acc.blocks)
    .map(b => ({ id: b.id, name: b.name, input: safeParseJson(b.args) }));
  const content = [];
  if (acc.text) content.push({ type: 'text', text: acc.text });
  for (const t of toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
  return { text: acc.text, toolCalls, assistantMessage: { role: 'assistant', content } };
}

// GET JSON simple (para autodetección de modelos). Timeout 8s.
function httpGetJson(fullUrl, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(fullUrl); } catch (e) { reject(e); return; }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
    };
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('models request timeout')));
    req.end();
  });
}

// --- IPC: autodetección de modelos del proveedor. Devuelve array de ids (o [] si falla). ---
ipcMain.handle('ai:listModels', async (event, config) => {
  const cfg = resolveAIConfig(config);
  const isAnthropic = cfg.api === 'anthropic';
  const path = isAnthropic ? '/v1/models' : '/models';
  const headers = isAnthropic
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': `Bearer ${cfg.apiKey}` };
  try {
    const json = await httpGetJson(cfg.baseUrl + path, headers);
    // Formatos: OpenAI-compat → { data: [{id}] }; Anthropic → { data: [{id}] };
    // Ollama /api/tags → { models: [{name}] }.
    const data = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
    const ids = data.map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    ids.sort((a, b) => a.localeCompare(b));
    console.log(`[RAZOR] listModels(${cfg.provider}) → ${ids.length} modelos`);
    return ids;
  } catch (err) {
    console.error(`[RAZOR] listModels(${cfg.provider}) failed:`, err.message);
    return [];
  }
});

// --- IPC: auto-update (electron-updater) ---
// electron-updater sólo funciona en la app EMPAQUETADA (lee app-update.yml + el
// latest.yml del release de GitHub). En dev (npm start) no hay nada de eso: el check
// dispara una SIMULACIÓN del flujo completo, emitiendo los mismos 'update:status' que
// el path real, para poder ver/QA el toast sin publicar un release.
let _autoUpdater;            // instancia cacheada (lazy require; puede quedar null)
let _updaterWired = false;   // listeners registrados una sola vez
let updateManual = false;    // el check en curso lo pidió el usuario → feedback visible

function getAutoUpdater() {
  if (_autoUpdater !== undefined) return _autoUpdater;
  try {
    _autoUpdater = require('electron-updater').autoUpdater;
    _autoUpdater.autoDownload = false;          // primero avisamos; el usuario decide
    _autoUpdater.autoInstallOnAppQuit = true;
    _autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  } catch (err) {
    console.error('[RAZOR] electron-updater no disponible:', err.message);
    _autoUpdater = null;
  }
  return _autoUpdater;
}

function sendUpdate(phase, extra) {
  sendToRenderer('update:status', { phase, manual: updateManual, ...(extra || {}) });
}

function wireAutoUpdater(up) {
  if (_updaterWired || !up) return;
  _updaterWired = true;
  up.on('checking-for-update', () => sendUpdate('checking'));
  up.on('update-available',     (info) => sendUpdate('available', { version: info && info.version }));
  up.on('update-not-available', () => sendUpdate('none'));
  up.on('download-progress',    (p) => sendUpdate('downloading', { percent: Math.round((p && p.percent) || 0) }));
  up.on('update-downloaded',    (info) => sendUpdate('downloaded', { version: info && info.version }));
  up.on('error',                (err) => sendUpdate('error', { error: (err && err.message) || String(err) }));
}

// Simulación en dev: mismos update:status que el path real, con timers.
let simTimers = [];
const SIM_VERSION = '0.2.0';
function clearSim() { simTimers.forEach(clearTimeout); simTimers = []; }
function simCheck() {
  clearSim();
  sendUpdate('checking');
  simTimers.push(setTimeout(() => sendUpdate('available', { version: SIM_VERSION }), 950));
}
function simDownload() {
  clearSim();
  let pct = 0;
  const tick = () => {
    pct += 4 + Math.floor(Math.random() * 15);
    if (pct >= 100) {
      sendUpdate('downloading', { percent: 100 });
      simTimers.push(setTimeout(() => sendUpdate('downloaded', { version: SIM_VERSION }), 450));
      return;
    }
    sendUpdate('downloading', { percent: pct });
    simTimers.push(setTimeout(tick, 240));
  };
  simTimers.push(setTimeout(tick, 200));
}

ipcMain.handle('update:check', (event, opts) => {
  updateManual = !!(opts && opts.manual);
  if (!app.isPackaged) { simCheck(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) { sendUpdate('error', { error: 'Updater unavailable.' }); return { ok: false }; }
  wireAutoUpdater(up);
  Promise.resolve(up.checkForUpdates()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:download', () => {
  if (!app.isPackaged) { simDownload(); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  Promise.resolve(up.downloadUpdate()).catch((err) => sendUpdate('error', { error: err.message }));
  return { ok: true };
});

ipcMain.handle('update:install', () => {
  if (!app.isPackaged) { console.log('[RAZOR] (dev sim) quitAndInstall'); sendUpdate('sim-install'); return { simulated: true }; }
  const up = getAutoUpdater();
  if (!up) return { ok: false };
  // CRÍTICO: sin isQuitting=true, el handler de 'close' esconde la ventana al tray y la
  // instalación nunca corre. Lo forzamos y salimos en el próximo tick.
  isQuitting = true;
  setImmediate(() => { try { up.quitAndInstall(); } catch (e) { console.error('[RAZOR] quitAndInstall falló:', e.message); } });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerHotkeys();
  // Chequeo automático al arrancar, sólo en la app empaquetada (en dev usá el comando
  // "Check for updates" de la paleta, que simula el flujo).
  if (app.isPackaged) {
    setTimeout(() => {
      updateManual = false;
      const up = getAutoUpdater();
      if (!up) return;
      wireAutoUpdater(up);
      Promise.resolve(up.checkForUpdates()).catch((err) => console.error('[RAZOR] auto update-check falló:', err.message));
    }, 4000);
  }
});

app.on('window-all-closed', () => {
  // Don't quit — window is hidden to tray, PTYs keep running
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  isQuitting = true;
  ptyProcesses.forEach(p => { try { p.kill(); } catch {} });
  ptyProcesses.clear();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});