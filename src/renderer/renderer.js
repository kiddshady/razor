/* RAZOR — Terminal AI · Renderer logic */
/* v0.1.0 — MVP: terminal PTY + tabs + window controls + AI dock stub */

/* ========== DIAGNOSTIC LOGGING ========== */
console.log('[RAZOR] renderer.js loaded');
console.log('[RAZOR] window.Terminal:', typeof window.Terminal);
console.log('[RAZOR] window.FitAddon:', typeof window.FitAddon);
console.log('[RAZOR] window.WebLinksAddon:', typeof window.WebLinksAddon);
console.log('[RAZOR] window.razor:', typeof window.razor);
console.log('[RAZOR] readyState:', document.readyState);

const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
const WebglAddon = window.WebglAddon?.WebglAddon || window.WebglAddon;

const razorAPI = window.razor;

if (!Terminal) console.error('[RAZOR] FATAL: window.Terminal is undefined! xterm.js did not load correctly.');
if (!FitAddon) console.error('[RAZOR] FATAL: window.FitAddon is undefined! addon-fit did not load correctly.');
if (!razorAPI) console.error('[RAZOR] FATAL: window.razor is undefined! preload.js did not load correctly.');

/* ========== STATE ========== */
const state = {
  tabs: [],
  activeTabId: null,
  tabIdCounter: 0,
  paletteOpen: false,
  paletteItems: [],
  paletteSelected: 0,
  lastOutput: '',   // último output del terminal activo (para contexto del AI)
  aiStreaming: false, // true mientras el AI está respondiendo
  aiCurrentMsg: null, // elemento DOM del mensaje AI actual (para streaming)
  aiMessages: [],     // historial de la conversación {role, content} (memoria entre mensajes)
  aiCurrentText: '',  // acumula la respuesta que se está streameando
  aiErrored: false,   // el turno actual falló (no guardar respuesta bogus en el historial)
  currentView: 'sessions',
  snippets: [],
  snippetIdCounter: 0,
  history: [],
  cmdBuffer: '',
  // Config del agente de IA (proveedor / API key / modelo). Default = comportamiento
  // original (Ollama Cloud + GLM); se persiste en localStorage y se manda al main
  // en cada consulta.
  aiSettings: { provider: 'ollama', apiKey: '', model: 'glm-5.2', baseUrl: 'https://ollama.com/v1', systemPrompt: '', toolPerms: { ...((razorAPI && razorAPI.toolPermsDefault) || {}) } },
  modelOptions: [],    // modelos disponibles del proveedor (autodetectados o known)
  modelsLoading: false, // true mientras se autodetectan modelos
  modelsReqId: 0,      // id de request para descartar detecciones viejas
  aiDockLocked: false,        // AI dock forzado oculto (solo en la vista Settings)
  aiDockPrevCollapsed: false, // estado del dock antes de entrar a Settings (para restaurar)
};

/* ========== AI PROVIDERS ========== */
// Presets por proveedor: baseUrl por defecto + sugerencias de modelo (datalist).
// La app soporta APIs OpenAI-compatible y Anthropic (el main resuelve el formato
// según el proveedor). El orden acá define el orden del dropdown.
const AI_PROVIDERS = {
  ollama:     { label: 'Ollama Cloud',              baseUrl: 'https://ollama.com/v1',        models: ['glm-5.2'] },
  openai:     { label: 'OpenAI',                    baseUrl: 'https://api.openai.com/v1',    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'] },
  anthropic:  { label: 'Anthropic',                 baseUrl: 'https://api.anthropic.com',    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] },
  openrouter: { label: 'OpenRouter',                baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o', 'google/gemini-2.5-pro'] },
  groq:       { label: 'Groq',                      baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'] },
  custom:     { label: 'Custom (OpenAI-compatible)', baseUrl: '',                            models: [] },
};
// Proveedores cloud que exigen API key (para el aviso previo al enviar). Ollama
// usa la key incorporada por defecto; custom puede apuntar a un server local sin key.
const KEY_REQUIRED = new Set(['openai', 'anthropic', 'openrouter', 'groq']);

/* ========== THEME (xterm) ========== */
const RAZOR_THEME = {
  // Transparente para que el grid de #terminal-container se vea a través del
  // terminal (con allowTransparency). Con WebGL, un bg opaco taparía el grid.
  background: 'rgba(10,10,15,0)',
  foreground: '#e0e0f0',
  cursor: '#00fff5',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(0,255,245,.22)',
  black: '#0a0a0f',
  red: '#ff0044',
  green: '#00ff88',
  yellow: '#ffee00',
  blue: '#0088ff',
  magenta: '#ff00aa',
  cyan: '#00fff5',
  white: '#e0e0f0',
  brightBlack: '#555577',
  brightRed: '#ff5577',
  brightGreen: '#55ffaa',
  brightYellow: '#ffee55',
  brightBlue: '#55aaff',
  brightMagenta: '#ff55cc',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

/* ========== TABS ========== */
// Parsea el payload de un OSC 7 (file://host/path) al path nativo del SO. Devuelve
// null si no se puede interpretar (dejamos el cwd anterior).
function parseOsc7Cwd(data) {
  if (!data) return null;
  let p = data;
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data);
  if (m) p = m[1];
  try { p = decodeURIComponent(p); } catch { /* si el decode falla, usamos el raw */ }
  // Windows: file:///C:/... → /C:/... → sacamos la barra líder y usamos backslashes.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  if (razorAPI && razorAPI.platform === 'win32') p = p.replace(/\//g, '\\');
  return p || null;
}

function createTab(name) {
  const id = ++state.tabIdCounter;
  const tab = {
    id,
    name: name || `shell ${id}`,
    ptyId: null,
    term: null,
    fitAddon: null,
    error: false,
    cwd: razorAPI.homeDir,
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  renderTabs();
  // Animate the new tab in
  const newEl = document.querySelector(`.tab[data-tab-id="${id}"]`);
  if (newEl) {
    newEl.classList.add('tab-entering');
    newEl.addEventListener('animationend', () => newEl.classList.remove('tab-entering'), { once: true });
  }
  initTerminal(tab);
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  const tabEl = document.querySelector(`.tab[data-tab-id="${id}"]`);
  const doClose = () => {
    if (tab.ptyId) razorAPI.pty.kill(tab.ptyId);
    if (tab.term) tab.term.dispose();
    state.tabs.splice(idx, 1);
    if (state.activeTabId === id) {
      state.activeTabId = state.tabs[0]?.id || null;
    }
    renderTabs();
    if (state.activeTabId) switchTab(state.activeTabId);
    else if (state.tabs.length === 0) createTab();
  };
  if (tabEl) {
    tabEl.classList.add('tab-leaving');
    setTimeout(doClose, 180);
  } else {
    doClose();
  }
}

function switchTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  state.activeTabId = id;
  // Hide all terminals, show the active one
  document.querySelectorAll('.term-instance').forEach(el => {
    el.style.display = 'none';
  });
  const termEl = document.getElementById(`term-${id}`);
  if (termEl) termEl.style.display = '';
  if (tab.fitAddon) tab.fitAddon.fit();
  if (tab.term) tab.term.focus();
  renderTabs();
}

function renderTabs() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  state.tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = `tab ${tab.id === state.activeTabId ? 'active' : ''} ${tab.error ? 'error' : ''}`;
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      <span class="tab-dot"></span>
      <svg class="tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
      <span class="tab-name">${escapeHtml(tab.name)}</span>
      <span class="tab-close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        closeTab(tab.id);
      } else {
        switchTab(tab.id);
      }
    });
    container.appendChild(el);
  });
}

/* ========== TERMINAL ========== */
function initTerminal(tab) {
  console.log('[RAZOR] initTerminal called for tab', tab.id);
  const container = document.getElementById('terminal-container');

  // Create a div for this terminal instance
  const termEl = document.createElement('div');
  termEl.id = `term-${tab.id}`;
  termEl.className = 'term-instance';
  // OJO: el FitAddon mide ESTE elemento (padre del .xterm) y NO descuenta su
  // padding. Por eso el margen externo va como `inset` (posición), no como
  // `padding`: así el ancho que mide el FitAddon es exacto y el texto no se
  // desborda bajo la scrollbar. El gutter interno (texto↔scrollbar) va en el .xterm.
  termEl.style.cssText = 'position:absolute;inset:14px 18px;';
  // Hide other instances
  document.querySelectorAll('.term-instance').forEach(el => el.style.display = 'none');
  container.appendChild(termEl);

  if (!Terminal) {
    console.error('[RAZOR] Cannot create terminal: Terminal constructor is undefined');
    termEl.innerHTML = '<pre style="color:#ff0044;padding:20px;font-family:monospace">[RAZOR] Error: xterm.js no se cargó correctamente.\nRevisá la consola (Ctrl+Shift+I) para más info.</pre>';
    return;
  }

  let term;
  let fitAddon;
  try {
    term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 14,
    lineHeight: 1.5,
    theme: RAZOR_THEME,
    // Cursor block idéntico en reposo y al escribir: mismo estilo con y sin foco
    // (block), sin blink, así el halo cyan (glow div) lo acompaña siempre. Arranca
    // con inactiveStyle 'none' y SIN foco: el cursor no se dibuja hasta el reveal
    // (ver positionGlow), que lo pasa a 'block' + foco. Evita el "agujero" en (0,0)
    // antes de que cargue el profile.
    cursorStyle: 'block',
    cursorInactiveStyle: 'none',
    cursorBlink: false,
    allowTransparency: true,
    scrollback: 10000,
    convertEol: false,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon()); } catch {}

  term.open(termEl);
    fitAddon.fit();
    // El primer fit() corre antes de que cargue la web font (JetBrains Mono):
    // xterm mide el glyph de un fallback más angosto y bloquea columnas de más,
    // por lo que el texto se desborda del padding y se mete bajo la scrollbar.
    // Re-medimos apenas la fuente real está cargada (por si cambia el ancho de celda).
    const refit = () => { try { fitAddon.fit(); } catch {} };
    requestAnimationFrame(refit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);

    // Renderer WebGL: dibuja en GPU y clippea la selección al viewport. Evita el
    // fantasma del DOM renderer (una selección scrolleada fuera de pantalla se
    // clampa al tope y pinta sobre texto no seleccionado). Fallback al DOM
    // renderer si el contexto WebGL se pierde o no está disponible.
    if (WebglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
        term.loadAddon(webgl);
      } catch (e) {
        console.warn('[RAZOR] WebGL no disponible, uso DOM renderer:', e && e.message);
      }
    }

    // Cursor glow: un div sigue al cursor y le pone el halo cyan (WebGL dibuja
    // el cursor en canvas, sin nodo DOM que pueda llevar el box-shadow).
    const glowEl = document.createElement('div');
    glowEl.className = 'cursor-glow';
    const positionGlow = () => {
      const screenEl = termEl.querySelector('.xterm-screen');
      const xtermEl = termEl.querySelector('.xterm');
      if (!screenEl || !xtermEl) return;
      if (glowEl.parentNode !== screenEl) screenEl.appendChild(glowEl);
      const buf = term.buffer.active;
      // Glow en reposo Y al escribir: el cursor es un block idéntico con o sin foco,
      // así que el halo cyan lo acompaña siempre. Excepciones donde se oculta: al
      // arrancar, con la terminal vacía y el cursor en el origen (0,0) el glow
      // quedaría pegado arriba a la izquierda sin prompt; tampoco scrolleado en el
      // historial ni con una selección activa.
      const atOrigin = buf.cursorX === 0 && buf.cursorY === 0; // terminal vacía / sin prompt aún
      if (!tab.shellStarted || atOrigin || buf.viewportY !== buf.baseY || term.hasSelection()) { glowEl.style.display = 'none'; return; }
      // Revelamos el cursor recién en el primer frame en que el glow se muestra: pasamos
      // el inactiveStyle a 'block' y enfocamos, así el block y su glow aparecen SIEMPRE
      // juntos, nunca antes (ni un "agujero" en 0,0). Una sola vez por tab.
      if (!tab.cursorRevealed) {
        tab.cursorRevealed = true;
        term.options.cursorInactiveStyle = 'block'; // de acá en más el block se ve con o sin foco
        term.focus();
      }
      const cw = screenEl.clientWidth / term.cols;
      const ch = screenEl.clientHeight / term.rows;
      glowEl.style.display = 'block';
      glowEl.style.left = (buf.cursorX * cw) + 'px';
      glowEl.style.top = (buf.cursorY * ch) + 'px';
      glowEl.style.width = cw + 'px';
      glowEl.style.height = ch + 'px';
    };
    term.onCursorMove(positionGlow);
    term.onRender(positionGlow);
    term.onSelectionChange(positionGlow);
    // El foco togglea la clase .focus en el .xterm. Aunque el cursor ya no cambia
    // de forma con el foco, observamos ese atributo para re-evaluar el glow en las
    // transiciones de foco de forma confiable (más robusto que focusin/focusout).
    const xtermForObs = termEl.querySelector('.xterm');
    if (xtermForObs && window.MutationObserver) {
      new MutationObserver(positionGlow).observe(xtermForObs, { attributes: true, attributeFilter: ['class'] });
    }
    requestAnimationFrame(positionGlow);

  // Ctrl+C: copy if selection exists, otherwise send SIGINT (\x03)
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.code === 'KeyC' && e.type === 'keydown') {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        return false; // prevent default (don't send \x03)
      }
      // no selection → let xterm send \x03 (SIGINT) to PTY
      return true;
    }
    // Ctrl+V: dejamos que xterm haga el paste nativo (evento 'paste' del DOM, que
    // respeta bracketed paste mode). NO pegamos a mano: el navegador dispara el
    // evento 'paste' igual, así que hacerlo acá lo duplicaba. Solo interceptamos el
    // keydown y devolvemos false para que xterm no mande ADEMÁS el control code
    // \x16 (Ctrl+V = "quoted insert").
    if (e.ctrlKey && e.code === 'KeyV' && e.type === 'keydown') {
      return false;
    }
    return true;
  });
  } catch (err) {
    console.error('[RAZOR] Terminal creation FAILED:', err);
    termEl.innerHTML = `<pre style="color:#ff0044;padding:20px;font-family:monospace">[RAZOR] Terminal init failed: ${err.message}</pre>`;
    return;
  }

  tab.term = term;
  tab.fitAddon = fitAddon;

  // OSC 7: el shell reporta su cwd en cada prompt (file:///path). Actualizamos
  // tab.cwd para que el agente (read_file relativo / shell_exec / cmd_exec) opere
  // en el directorio real del usuario, no en el inicial.
  try {
    term.parser.registerOscHandler(7, (uri) => {
      const cwd = parseOsc7Cwd(uri);
      if (cwd) tab.cwd = cwd;
      return true; // consumido: xterm no debe imprimir la secuencia
    });
  } catch (e) { console.warn('[RAZOR] OSC7 handler no disponible:', e && e.message); }

  // PTY data → terminal (register BEFORE creating PTY to avoid race condition)
  razorAPI.pty.onData((id, data) => {
    if (id === tab.ptyId && tab.term) {
      tab.shellStarted = true; // primer output: abre el gate del glow (y del reveal del cursor)
      tab.term.write(data);
      // Track last output for AI context (only for active tab)
      if (tab.id === state.activeTabId) {
        state.lastOutput = (state.lastOutput + data.toString()).slice(-4000);
      }
      detectErrors(tab, data);
    }
  });

  razorAPI.pty.onExit((id, exitCode) => {
    if (id === tab.ptyId) {
      tab.term.write(`\r\n\x1b[38;2;136;136;170m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      updateStatusExit(exitCode);
    }
  });

  // Terminal input → PTY
  term.onData(data => {
    console.log('[RAZOR] term.onData fired, ptyId=', tab.ptyId, 'data=', JSON.stringify(data));
    if (tab.ptyId) {
      razorAPI.pty.write(tab.ptyId, data);
    } else {
      console.warn('[RAZOR] term.onData but tab.ptyId is null! PTY not ready yet');
    }
    trackCommand(data, tab);
  });

  // Create PTY
  razorAPI.pty.create({
    cols: term.cols,
    rows: term.rows,
    cwd: tab.cwd,
  }).then(ptyId => {
    tab.ptyId = ptyId;
    console.log('[RAZOR] PTY created, ptyId=', ptyId);
    // No enfocamos acá: el foco y el cursor block se revelan con el prompt (positionGlow).
  }).catch(err => {
    console.error('[RAZOR] PTY creation FAILED:', err);
    term.write(`\r\n\x1b[38;2;255;0;68m[PTY ERROR: ${err.message || err}]\x1b[0m\r\n`);
  });

  // Resize
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId) razorAPI.pty.resize(tab.ptyId, cols, rows);
  });

  // Focus on click — ensure terminal grabs keyboard focus when clicked
  termEl.addEventListener('mousedown', (e) => {
    if (tab.term) tab.term.focus();
  });
}

/* ========== ERROR DETECTION ========== */
const ERROR_PATTERNS = [
  /error\s+TS\d+:/i,
  /SyntaxError:/,
  /TypeError:/,
  /ReferenceError:/,
  /Module not found/i,
  /Command not found/i,
  /No such file or directory/i,
  /Permission denied/i,
  /\berror\b.*\.ts:\d+/i,
  /\berror\b.*\.js:\d+/i,
  /npm ERR!/i,
  /fatal:/i,
];

function detectErrors(tab, data) {
  const text = data.toString();
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      tab.error = true;
      renderTabs();
      showBottomBar(text);
      break;
    }
  }
}

function showBottomBar(errorText) {
  const bar = document.getElementById('bottom-bar');
  const msg = document.getElementById('err-msg');
  const fix = document.getElementById('err-fix');
  const loc = document.getElementById('err-loc');

  // Try to extract error location
  const locMatch = errorText.match(/([^\s]+\.(?:ts|js|py|go|rs|c|cpp)):(\d+)/);
  if (locMatch) {
    loc.textContent = `${locMatch[1]}:${locMatch[2]}`;
  } else {
    loc.textContent = 'detectado en output';
  }

  msg.innerHTML = `Se detectó un error en la salida del terminal. Revisá el output arriba.`;
  fix.innerHTML = `<span class="kw">await</span> <span class="fn">analyze</span>(<span class="obj">error</span>)`;
  bar.classList.remove('hidden');
}

function hideBottomBar() {
  document.getElementById('bottom-bar').classList.add('hidden');
  // Clear error state on active tab
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab) {
    tab.error = false;
    renderTabs();
  }
}

/* ========== STATUS BAR ========== */
function updateStatusExit(code) {
  const el = document.getElementById('status-exit');
  if (code === 0) {
    el.innerHTML = `<span style="color:var(--text-faint)">exit </span><span style="color:var(--green)">0</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--text-faint)">exit </span><span class="err">${code}</span>`;
  }
}

function updateClock() {
  const el = document.getElementById('status-time');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ========== AI DOCK ========== */
const AI_HISTORY_MAX = 40; // cap de mensajes en el historial (20 intercambios)

async function sendAIMessage() {
  const input = document.getElementById('ai-input');
  const msg = input.value.trim();
  if (!msg || state.aiStreaming) return;

  // Aviso si el proveedor elegido necesita API key y no está seteada (no ensuciamos
  // el historial de la conversación en este caso).
  const cfg = state.aiSettings || {};
  if (KEY_REQUIRED.has(cfg.provider) && !cfg.apiKey) {
    addAIMessage(msg, 'user');
    input.value = '';
    addAIMessage(`No API key set for ${AI_PROVIDERS[cfg.provider]?.label || cfg.provider}. Open Settings (gear icon) and paste your key.`, 'ai');
    return;
  }

  input.value = '';
  addAIMessage(msg, 'user');

  // Guardar el mensaje del usuario en el historial (memoria entre mensajes)
  state.aiMessages.push({ role: 'user', content: msg });
  state.aiCurrentText = '';
  state.aiErrored = false;

  // Crear mensaje AI vacío para streaming
  state.aiCurrentMsg = createAIStreamMessage();
  state.aiStreaming = true;

  // Contexto del terminal activo
  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  const context = {
    cwd: activeTab?.cwd || '~',
    branch: '',
    lastOutput: state.lastOutput || '',
  };

  try {
    // Mandamos toda la conversación (incluye el mensaje recién agregado) + la
    // config del agente (proveedor / key / modelo / baseUrl).
    await razorAPI.ai.chat(state.aiMessages, context, state.aiSettings);
  } catch (e) {
    showAIError(`❌ Error: ${e.message || e}`);
    finalizeAIMessage();
  }
}

function createAIStreamMessage() {
  const container = document.getElementById('ai-messages');
  const ph = container.querySelector('.ai-placeholder');
  if (ph) ph.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'ai-msg';
  msgEl.innerHTML = `
    <div class="ai-avatar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="12" rx="3.5"/><path d="M12 7V4.3"/><circle cx="12" cy="3.2" r="1.15" fill="currentColor" stroke="none"/><path d="M3.5 11.5v3"/><path d="M20.5 11.5v3"/><path d="M9.5 11.5v3"/><path d="M14.5 11.5v3"/></svg>
    </div>
    <div class="ai-bubble"><span class="ai-typing">▋</span></div>
  `;
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
  return msgEl.querySelector('.ai-bubble');
}

function appendAIChunk(chunk) {
  // Si no hay burbuja activa (arranque del turno, o se cerró tras una tool call),
  // creamos una nueva para seguir streameando debajo del chip de la herramienta.
  if (!state.aiCurrentMsg) state.aiCurrentMsg = createAIStreamMessage();
  // Sacar el cursor de typing si existe
  const typing = state.aiCurrentMsg.querySelector('.ai-typing');
  if (typing) typing.remove();
  state.aiCurrentText += chunk; // acumular para guardar en el historial
  state.aiCurrentMsg.innerHTML += escapeHtml(chunk);
  // Re-agregar cursor
  state.aiCurrentMsg.innerHTML += '<span class="ai-typing">▋</span>';
  const container = document.getElementById('ai-messages');
  container.scrollTop = container.scrollHeight;
}

// Muestra un error en la burbuja SIN acumularlo como respuesta del historial.
// Si no hay burbuja activa (p.ej. el error cae justo tras una tool call), creamos
// una para que el error siempre sea visible.
function showAIError(errText) {
  state.aiErrored = true;
  if (!state.aiCurrentMsg) state.aiCurrentMsg = createAIStreamMessage();
  const typing = state.aiCurrentMsg.querySelector('.ai-typing');
  if (typing) typing.remove();
  state.aiCurrentMsg.innerHTML += `<span style="color:var(--red)">${escapeHtml(errText)}</span>`;
  const container = document.getElementById('ai-messages');
  container.scrollTop = container.scrollHeight;
}

function finalizeAIMessage() {
  if (!state.aiStreaming) return; // idempotente (onDone y onError pueden solaparse)
  if (state.aiCurrentMsg) {
    const typing = state.aiCurrentMsg.querySelector('.ai-typing');
    if (typing) typing.remove();
  }
  // Guardar la respuesta en el historial (memoria). Si el turno falló sin
  // respuesta válida, sacamos el mensaje de usuario colgado para no dejar dos
  // turns de 'user' seguidos (mantiene la conversación bien formada).
  const text = (state.aiCurrentText || '').trim();
  if (text && !state.aiErrored) {
    state.aiMessages.push({ role: 'assistant', content: text });
    if (state.aiMessages.length > AI_HISTORY_MAX) {
      state.aiMessages = state.aiMessages.slice(-AI_HISTORY_MAX);
    }
  } else if (state.aiMessages[state.aiMessages.length - 1]?.role === 'user') {
    state.aiMessages.pop();
  }
  state.aiCurrentText = '';
  state.aiErrored = false;
  state.aiCurrentMsg = null;
  state.aiStreaming = false;
}

// AI streaming listeners
razorAPI.ai.onChunk((chunk) => appendAIChunk(chunk));
razorAPI.ai.onTool((info) => {
  // 'running' y 'denied' crean un chip nuevo; 'done'/'error' actualizan el existente.
  if (info.status === 'running' || info.status === 'denied') renderToolChip(info);
  else updateToolChip(info);
});
razorAPI.ai.onToolConfirm((info) => renderToolConfirm(info));
razorAPI.ai.onDone(() => finalizeAIMessage());
razorAPI.ai.onError((err) => {
  showAIError(`\n❌ Error: ${err}`);
  finalizeAIMessage();
});

/* ========== AUTO-UPDATE TOAST ========== */
/* Refleja el flujo del updater del main: checking → available → downloading (barra) →
   downloaded → install. Un solo nodo que muta de estado con transiciones; durante la
   descarga sólo movemos el ancho de la barra (sin reconstruir) para que la animación
   de width sea continua. Los checks automáticos (manual=false) que no traen novedad se
   silencian; los manuales (comando de la paleta) siempre dan feedback. */
const UT_SVG = {
  rocket: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  spin: '<svg class="ut-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
  restart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const updateToast = {
  _node: null,
  _hideTimer: 0,
  get node() { return this._node || (this._node = document.getElementById('update-toast')); },
  render(inner, variant) {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);
    n.classList.remove('ready', 'error');
    if (variant) n.classList.add(variant);
    n.innerHTML = inner;
    // Forzamos un reflow para que el estado "oculto" (opacity 0 + translateX) quede
    // comprometido ANTES de agregar .show; si no, el navegador coalesce ambos frames
    // y la caja aparece de golpe en vez de deslizarse (mata la transición de entrada).
    void n.offsetWidth;
    n.classList.add('show');
  },
  autoDismiss(ms) {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.dismiss(), ms);
  },
  dismiss() {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);
    n.classList.remove('show');
    // Limpiamos el contenido recién cuando terminó la transición de salida.
    this._hideTimer = setTimeout(() => {
      if (!n.classList.contains('show')) { n.innerHTML = ''; updateToastPhase = null; }
    }, 340);
  },
};
let updateToastPhase = null;

function utRow(icon, label, title, sub, closable) {
  return (
    `<div class="ut-row">` +
      `<span class="ut-icon">${icon}</span>` +
      `<div class="ut-content">` +
        `<div class="ut-label">${label}</div>` +
        `<div class="ut-title">${title}</div>` +
        (sub ? `<div class="ut-sub">${sub}</div>` : '') +
      `</div>` +
      (closable ? `<button class="ut-close" data-ut="later" title="Dismiss">${UT_SVG.x}</button>` : '') +
    `</div>`
  );
}

function renderUpdate(status) {
  const phase = status.phase;
  const version = status.version ? escapeHtml(String(status.version)) : '';
  const manual = !!status.manual;

  // Descarga en curso: sólo actualizamos la barra (transición de width continua).
  if (phase === 'downloading' && updateToastPhase === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
    const bar = updateToast.node?.querySelector('.ut-progress-bar');
    const num = updateToast.node?.querySelector('.ut-pct');
    if (bar) bar.style.width = pct + '%';
    if (num) num.textContent = pct + '%';
    return;
  }
  updateToastPhase = phase;

  switch (phase) {
    case 'checking':
      if (!manual) return; // auto-check: en silencio hasta que haya novedad
      updateToast.render(utRow(UT_SVG.spin, 'Checking', 'Checking for updates…', '', false));
      break;
    case 'available':
      updateToast.render(
        utRow(UT_SVG.rocket, 'Update', `RAZOR <b>v${version}</b> is available`, 'A new version is ready to download.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="download">Download</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`
      );
      break;
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
      updateToast.render(
        utRow(UT_SVG.down, 'Downloading', `Downloading update… <span class="ut-pct">${pct}%</span>`, '', false) +
        `<div class="ut-progress"><div class="ut-progress-bar" style="width:${pct}%"></div></div>`
      );
      break;
    }
    case 'downloaded':
      updateToast.render(
        utRow(UT_SVG.check, 'Ready', `RAZOR <b>v${version}</b> downloaded`, 'Restart to finish installing.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="install">Restart & install</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`,
        'ready'
      );
      break;
    case 'none':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.check, 'Up to date', 'Already on the latest version.', '', true), 'ready');
      updateToast.autoDismiss(2800);
      break;
    case 'error':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.alert, 'Update failed', escapeHtml(status.error || 'Couldn\'t check for updates.'), '', true), 'error');
      updateToast.autoDismiss(4200);
      break;
    case 'sim-install':
      updateToast.render(utRow(UT_SVG.restart, 'Installing', 'Restarting to install… (simulated in dev)', '', false), 'ready');
      updateToast.autoDismiss(2800);
      break;
  }
}

razorAPI.update.onStatus(renderUpdate);

// Delegación de clicks del toast: descargar / instalar / descartar.
updateToast.node?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ut]');
  if (!btn) return;
  const act = btn.dataset.ut;
  if (act === 'download') {
    razorAPI.update.download();
    renderUpdate({ phase: 'downloading', percent: 0 }); // feedback inmediato al click
  } else if (act === 'install') {
    razorAPI.update.install();
  } else {
    updateToast.dismiss();
  }
});

// Chip de actividad de herramienta. Se inserta en el flujo del dock cuando el agente
// llama a una tool (read_file / list_dir / path_info / shell_exec / cmd_exec).
function argSummary(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.path === 'string') return input.path;
  if (typeof input.command === 'string') return input.command;
  try { return JSON.stringify(input); } catch { return ''; }
}
// Cierra la burbuja de streaming en curso (saca el cursor; si quedó vacía, la
// elimina) para insertar un chip/card de tool en orden. Devuelve el container.
function closeStreamBubble() {
  const container = document.getElementById('ai-messages');
  if (state.aiCurrentMsg) {
    const typing = state.aiCurrentMsg.querySelector('.ai-typing');
    if (typing) typing.remove();
    if (!state.aiCurrentMsg.textContent.trim()) state.aiCurrentMsg.closest('.ai-msg')?.remove();
    state.aiCurrentMsg = null;
  }
  return container;
}
function renderToolChip(info) {
  const container = closeStreamBubble();
  if (!container) return;
  const st = info.status || 'running';
  const chip = document.createElement('div');
  chip.className = `ai-tool-chip ${st}`;
  if (info.id) chip.dataset.toolId = info.id;
  chip.innerHTML =
    `${TOOL_SVG}<span class="ai-tool-name">${escapeHtml(info.name || 'tool')}</span>` +
    `<span class="ai-tool-arg">${escapeHtml(argSummary(info.input))}</span>` +
    `<span class="ai-tool-status">${escapeHtml(st)}</span>`;
  container.appendChild(chip);
  container.scrollTop = container.scrollHeight;
}
// Card de confirmación para tools en modo "ask". Bloquea hasta que el usuario
// decide: Deny / Allow once / Always allow (esta última persiste el permiso).
function renderToolConfirm(info) {
  const container = closeStreamBubble();
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'ai-tool-confirm';
  card.innerHTML =
    `<div class="ai-confirm-head">${WARN_SVG}<span>El agente quiere ejecutar <b>${escapeHtml(info.name || 'tool')}</b></span></div>` +
    `<div class="ai-confirm-cmd">${escapeHtml(argSummary(info.input))}</div>` +
    `<div class="ai-confirm-actions">` +
      `<button type="button" class="ai-confirm-btn deny">Denegar</button>` +
      `<button type="button" class="ai-confirm-btn allow">Permitir</button>` +
      `<button type="button" class="ai-confirm-btn always">Permitir siempre</button>` +
    `</div>`;
  container.appendChild(card);
  const resolve = (decision, always) => {
    if (always && info.name) {
      state.aiSettings.toolPerms[info.name] = 'allow';
      persistAISettings();
    }
    card.classList.add(decision === 'deny' ? 'resolved-deny' : 'resolved-allow');
    const actions = card.querySelector('.ai-confirm-actions');
    if (actions) actions.innerHTML = `<span class="ai-confirm-result">${decision === 'deny' ? 'denegado' : (always ? 'permitido siempre' : 'permitido')}</span>`;
    razorAPI.ai.confirmTool(info.cid, decision);
  };
  card.querySelector('.deny').addEventListener('click', () => resolve('deny', false));
  card.querySelector('.allow').addEventListener('click', () => resolve('allow', false));
  card.querySelector('.always').addEventListener('click', () => resolve('allow', true));
  container.scrollTop = container.scrollHeight;
}
function updateToolChip(info) {
  const container = document.getElementById('ai-messages');
  if (!container) return;
  const chips = container.querySelectorAll('.ai-tool-chip.running');
  // Buscamos por id; si no vino, caemos al último chip corriendo.
  let chip = null;
  if (info.id) chip = container.querySelector(`.ai-tool-chip[data-tool-id="${CSS.escape(info.id)}"]`);
  if (!chip) chip = chips[chips.length - 1];
  if (!chip) return;
  const ok = info.status !== 'error';
  chip.classList.remove('running');
  chip.classList.add(ok ? 'done' : 'error');
  const st = chip.querySelector('.ai-tool-status');
  if (st) st.textContent = ok ? 'done' : 'error';
}

function addAIMessage(text, role) {
  const container = document.getElementById('ai-messages');
  // Remove placeholder
  const ph = container.querySelector('.ai-placeholder');
  if (ph) ph.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'ai-msg';
  if (role === 'user') {
    msgEl.innerHTML = `
      <div class="ai-avatar" style="border-color:rgba(0,255,245,.4);color:var(--cyan)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
      </div>
      <div class="ai-bubble" style="border-left-color:var(--cyan)">${escapeHtml(text)}</div>
    `;
  } else {
    msgEl.innerHTML = `
      <div class="ai-avatar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="12" rx="3.5"/><path d="M12 7V4.3"/><circle cx="12" cy="3.2" r="1.15" fill="currentColor" stroke="none"/><path d="M3.5 11.5v3"/><path d="M20.5 11.5v3"/><path d="M9.5 11.5v3"/><path d="M14.5 11.5v3"/></svg>
      </div>
      <div class="ai-bubble">${escapeHtml(text)}</div>
    `;
  }
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

/* ========== SVG ICONS (from Penumbra) ========== */
const SVG_ICONS = {
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  robot: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="11.5" rx="3.5"/><path d="M12 5V2.8"/><circle cx="12" cy="1.8" r="1.1" fill="currentColor" stroke="none"/><path d="M3.5 9.5v2.5"/><path d="M20.5 9.5v2.5"/><path d="M9.5 9.4v2.8"/><path d="M14.5 9.4v2.8"/><path d="M5.5 21v-1.5a2.5 2.5 0 0 1 2.5-2.5h8a2.5 2.5 0 0 1 2.5 2.5V21"/></svg>',
  rotate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

/* ========== COMMAND PALETTE ========== */
const PALETTE_COMMANDS = [
  { id: 'new-tab', label: 'New tab', shortcut: 'Ctrl+T', icon: SVG_ICONS.plus, action: () => createTab() },
  { id: 'close-tab', label: 'Close active tab', shortcut: 'Ctrl+W', icon: SVG_ICONS.x, action: () => closeTab(state.activeTabId) },
  { id: 'toggle-ai', label: 'Toggle AI dock', shortcut: 'Ctrl+Shift+A', icon: SVG_ICONS.robot, action: () => toggleAIDock() },
  { id: 'clear', label: 'Clear terminal', shortcut: 'Ctrl+L', icon: SVG_ICONS.rotate, action: () => clearTerminal() },
  { id: 'snippets', label: 'View snippets', shortcut: '', icon: SVG_ICONS.code, action: () => switchView('snippets') },
  { id: 'history', label: 'View history', shortcut: '', icon: SVG_ICONS.clock, action: () => switchView('history') },
  { id: 'settings', label: 'Settings', shortcut: '', icon: SVG_ICONS.gear, action: () => switchView('settings') },
  { id: 'check-updates', label: 'Check for updates', shortcut: '', icon: SVG_ICONS.download, action: () => razorAPI.update.check(true) },
];

function openPalette() {
  state.paletteOpen = true;
  state.paletteSelected = 0;
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  overlay.classList.remove('hidden');
  input.value = '';
  input.focus();
  renderPalette('');
}

function closePalette() {
  state.paletteOpen = false;
  document.getElementById('palette-overlay').classList.add('hidden');
}

function renderPalette(query) {
  const results = document.getElementById('palette-results');
  const filtered = query
    ? PALETTE_COMMANDS.filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
    : PALETTE_COMMANDS;
  state.paletteItems = filtered;
  state.paletteSelected = 0;
  results.innerHTML = '';
  filtered.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `palette-item ${i === 0 ? 'selected' : ''}`;
    el.innerHTML = `
      <span class="pi-icon">${item.icon}</span>
      <span class="pi-label">${escapeHtml(item.label)}</span>
      ${item.shortcut ? `<span class="pi-shortcut">${item.shortcut}</span>` : ''}
    `;
    el.addEventListener('click', () => executePaletteItem(i));
    results.appendChild(el);
  });
}

function executePaletteItem(index) {
  const item = state.paletteItems[index];
  if (!item) return;
  closePalette();
  item.action();
}

function movePaletteSelection(dir) {
  state.paletteSelected = (state.paletteSelected + dir + state.paletteItems.length) % state.paletteItems.length;
  document.querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('selected', i === state.paletteSelected);
  });
  const sel = document.querySelector('.palette-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

/* ========== UTILS ========== */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toggleAIDock() {
  if (state.aiDockLocked) return; // bloqueado mientras estás en la vista Settings
  const dock = document.getElementById('ai-dock');
  dock.classList.toggle('collapsed');
}

function clearTerminal() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab?.term) tab.term.clear();
  hideBottomBar();
}

/* ========== VIEW SWITCHING ========== */
function switchView(view) {
  state.currentView = view;
  const termContainer = document.getElementById('terminal-container');
  const snippetsPanel = document.getElementById('snippets-panel');
  const historyPanel = document.getElementById('history-panel');
  const settingsPanel = document.getElementById('settings-panel');

  termContainer.style.display = 'none';
  termContainer.classList.remove('view-active');
  snippetsPanel.classList.add('hidden');
  historyPanel.classList.add('hidden');
  settingsPanel.classList.add('hidden');

  if (view === 'sessions') {
    termContainer.style.display = '';
    termContainer.classList.add('view-active');
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab?.fitAddon) tab.fitAddon.fit();
    if (tab?.term) tab.term.focus();
  } else if (view === 'snippets') {
    snippetsPanel.classList.remove('hidden');
    renderSnippets();
  } else if (view === 'history') {
    historyPanel.classList.remove('hidden');
    renderHistory();
  } else if (view === 'settings') {
    settingsPanel.classList.remove('hidden');
    renderSettings();
  }

  // AI dock: se oculta y queda bloqueado SOLO en la vista Settings. Al salir se
  // restaura al estado que tenía antes de entrar (colapsado o no).
  const aiDock = document.getElementById('ai-dock');
  if (view === 'settings') {
    if (!state.aiDockLocked) {
      state.aiDockPrevCollapsed = aiDock.classList.contains('collapsed');
      state.aiDockLocked = true;
    }
    aiDock.classList.add('collapsed');
  } else if (state.aiDockLocked) {
    state.aiDockLocked = false;
    aiDock.classList.toggle('collapsed', state.aiDockPrevCollapsed);
  }

  document.querySelectorAll('.side-icon[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

/* ========== SNIPPETS ========== */
function loadSnippets() {
  try {
    const saved = localStorage.getItem('razor-snippets');
    if (saved) {
      state.snippets = JSON.parse(saved);
      state.snippetIdCounter = state.snippets.reduce((max, s) => Math.max(max, s.id), 0);
    }
  } catch {}
}

function saveSnippets() {
  try { localStorage.setItem('razor-snippets', JSON.stringify(state.snippets)); } catch {}
}

function addSnippet() {
  const nameInput = document.getElementById('snippet-name');
  const cmdInput = document.getElementById('snippet-cmd');
  const name = nameInput.value.trim();
  const cmd = cmdInput.value.trim();
  if (!name || !cmd) return;
  state.snippets.unshift({ id: ++state.snippetIdCounter, name, cmd, created: Date.now() });
  saveSnippets();
  nameInput.value = '';
  cmdInput.value = '';
  renderSnippets();
  // Animar la entrada del nuevo snippet (queda primero por el unshift).
  const nuevo = document.querySelector('#snippet-list .snippet-item');
  if (nuevo) {
    nuevo.classList.add('snippet-entering');
    nuevo.addEventListener('animationend', () => nuevo.classList.remove('snippet-entering'), { once: true });
  }
}

function deleteSnippet(id) {
  // Animar la salida antes de sacarlo del estado y re-renderizar.
  const el = document.querySelector(`#snippet-list .snippet-item[data-id="${id}"]`);
  const doDelete = () => {
    state.snippets = state.snippets.filter(s => s.id !== id);
    saveSnippets();
    renderSnippets();
  };
  if (el) {
    el.classList.add('snippet-leaving');
    setTimeout(doDelete, 180);
  } else {
    doDelete();
  }
}

function runSnippet(id) {
  const snippet = state.snippets.find(s => s.id === id);
  if (!snippet) return;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab?.ptyId) razorAPI.pty.write(tab.ptyId, snippet.cmd + '\r');
  switchView('sessions');
}

function renderSnippets() {
  const list = document.getElementById('snippet-list');
  if (!list) return;
  if (state.snippets.length === 0) {
    list.innerHTML = '<div class="panel-empty">No snippets saved.<br>Create one above.</div>';
    return;
  }
  list.innerHTML = '';
  state.snippets.forEach(s => {
    const el = document.createElement('div');
    el.className = 'snippet-item';
    el.dataset.id = s.id;
    el.innerHTML = `
      <div class="snippet-info">
        <div class="snippet-name">${escapeHtml(s.name)}</div>
        <div class="snippet-cmd">${escapeHtml(s.cmd)}</div>
      </div>
      <div class="snippet-actions">
        <button class="snippet-run" data-id="${s.id}" title="Run">${SVG_ICONS.play}</button>
        <button class="snippet-del" data-id="${s.id}" title="Delete">${SVG_ICONS.trash}</button>
      </div>
    `;
    list.appendChild(el);
  });
  list.querySelectorAll('.snippet-run').forEach(btn => {
    btn.addEventListener('click', () => runSnippet(parseInt(btn.dataset.id)));
  });
  list.querySelectorAll('.snippet-del').forEach(btn => {
    btn.addEventListener('click', () => deleteSnippet(parseInt(btn.dataset.id)));
  });
}

/* ========== HISTORY ========== */
function addHistoryEntry(cmd, tabName) {
  if (!cmd.trim()) return;
  state.history.unshift({ cmd, tab: tabName, time: Date.now() });
  if (state.history.length > 500) state.history.pop();
  if (state.currentView === 'history') renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (state.history.length === 0) {
    list.innerHTML = '<div class="panel-empty">History is empty.<br>Run commands in the terminal to see them here.</div>';
    return;
  }
  list.innerHTML = '';
  state.history.forEach(h => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const timeStr = new Date(h.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `
      <div class="history-time">${timeStr}</div>
      <div class="history-cmd">${escapeHtml(h.cmd)}</div>
      <div class="history-tab">${escapeHtml(h.tab)}</div>
    `;
    el.addEventListener('click', () => {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab?.ptyId) razorAPI.pty.write(tab.ptyId, h.cmd + '\r');
      switchView('sessions');
    });
    list.appendChild(el);
  });
}

function clearHistory() {
  state.history = [];
  renderHistory();
}

function trackCommand(data, tab) {
  // Strip ANSI escape sequences (CSI, OSC, SS3, etc.) before processing
  const clean = data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b./g, '');
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') {
      if (state.cmdBuffer.trim()) addHistoryEntry(state.cmdBuffer.trim(), tab.name);
      state.cmdBuffer = '';
    } else if (code === 127 || code === 8) {
      state.cmdBuffer = state.cmdBuffer.slice(0, -1);
    } else if (code === 3) {
      state.cmdBuffer = '';
    } else if (code >= 32 && code < 127) {
      state.cmdBuffer += ch;
    }
  }
}

/* ========== SETTINGS (AI agent) ========== */
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
// Icono para el chip de herramienta del agente (terminal/chevron — sin glyphs).
const TOOL_SVG = '<svg class="ai-tool-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="19" y2="16"/></svg>';
// Icono de advertencia para la card de confirmación de tools peligrosas (sin glyphs).
const WARN_SVG = '<svg class="ai-confirm-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function loadAISettings() {
  try {
    const saved = localStorage.getItem('razor-ai-settings');
    if (saved) state.aiSettings = { ...state.aiSettings, ...JSON.parse(saved) };
  } catch {}
  // Merge de permisos: garantiza que toda tool del catálogo tenga un permiso,
  // aunque el guardado sea viejo y no la incluya (default gana sólo si falta).
  state.aiSettings.toolPerms = { ...(razorAPI.toolPermsDefault || {}), ...(state.aiSettings.toolPerms || {}) };
}

function persistAISettings() {
  try { localStorage.setItem('razor-ai-settings', JSON.stringify(state.aiSettings)); } catch {}
}

/* ---- Dropdowns custom (reemplazan <select>/<datalist> nativos para poder
   estilar la lista abierta con la estética cyberpunk). ---- */
function closeAllDropdowns() {
  document.querySelectorAll('.rz-select.open, .rz-combo.open').forEach(el => el.classList.remove('open'));
}
function toggleDropdown(wrapper) {
  const willOpen = !wrapper.classList.contains('open');
  closeAllDropdowns();
  if (willOpen) wrapper.classList.add('open');
}

// Provider: dropdown NO editable.
function buildProviderOptions() {
  const box = document.getElementById('ai-provider-options');
  if (!box || box.childElementCount) return;
  Object.entries(AI_PROVIDERS).forEach(([id, p]) => {
    const el = document.createElement('div');
    el.className = 'rz-option';
    el.dataset.value = id;
    el.innerHTML = `<span class="rz-option-label">${escapeHtml(p.label)}</span><span class="rz-option-check">${CHECK_SVG}</span>`;
    el.addEventListener('click', () => selectProvider(id));
    box.appendChild(el);
  });
}
function getProviderUI() {
  return document.getElementById('ai-provider-select')?.dataset.value || 'ollama';
}
function setProviderUI(id) {
  const chosen = AI_PROVIDERS[id] ? id : 'custom';
  document.getElementById('ai-provider-select').dataset.value = chosen;
  document.getElementById('ai-provider-value').textContent = AI_PROVIDERS[chosen]?.label || chosen;
  document.querySelectorAll('#ai-provider-options .rz-option').forEach(o => {
    o.classList.toggle('selected', o.dataset.value === chosen);
  });
}
function selectProvider(id) {
  setProviderUI(id);
  closeAllDropdowns();
  onProviderChange(id);
}
// Al cambiar de proveedor: Base URL al preset, modelo al primero conocido, y re-detecto.
function onProviderChange(id) {
  const p = AI_PROVIDERS[id];
  const modelInput = document.getElementById('ai-model');
  if (p) {
    document.getElementById('ai-baseurl').value = p.baseUrl;
    modelInput.value = p.models[0] || '';
  }
  state.modelOptions = (p?.models || []).slice();
  renderModelOptions(modelInput.value);
  detectModels();
}

// Model: combobox editable (input + lista custom) con autodetección.
function renderModelOptions(filter) {
  const box = document.getElementById('ai-model-options');
  if (!box) return;
  if (state.modelsLoading) {
    box.innerHTML = '<div class="rz-options-status">Detecting models…</div>';
    return;
  }
  const list = state.modelOptions || [];
  const f = (filter || '').trim().toLowerCase();
  const filtered = f ? list.filter(m => m.toLowerCase().includes(f)) : list;
  if (!filtered.length) {
    box.innerHTML = `<div class="rz-options-empty">${list.length ? 'No matches — type a custom id' : 'No models detected — type one'}</div>`;
    return;
  }
  const current = document.getElementById('ai-model').value;
  box.innerHTML = '';
  filtered.slice(0, 100).forEach(m => {
    const el = document.createElement('div');
    el.className = 'rz-option' + (m === current ? ' selected' : '');
    el.dataset.value = m;
    el.innerHTML = `<span class="rz-option-label">${escapeHtml(m)}</span><span class="rz-option-check">${CHECK_SVG}</span>`;
    el.addEventListener('click', () => {
      document.getElementById('ai-model').value = m;
      closeAllDropdowns();
    });
    box.appendChild(el);
  });
}
function openModelCombo() {
  const combo = document.getElementById('ai-model-combo');
  closeAllDropdowns();
  combo.classList.add('open');
  if (!state.modelOptions.length && !state.modelsLoading) detectModels();
  renderModelOptions(document.getElementById('ai-model').value);
}
function toggleModelCombo() {
  const combo = document.getElementById('ai-model-combo');
  if (combo.classList.contains('open')) closeAllDropdowns();
  else openModelCombo();
}
// Item 5: autodetección de modelos desde la API del proveedor (vía main process).
async function detectModels() {
  if (!razorAPI.ai || !razorAPI.ai.listModels) return;
  const provider = getProviderUI();
  const cfg = {
    provider,
    apiKey: document.getElementById('ai-apikey').value.trim(),
    baseUrl: document.getElementById('ai-baseurl').value.trim() || (AI_PROVIDERS[provider]?.baseUrl || ''),
  };
  const reqId = ++state.modelsReqId;
  state.modelsLoading = true;
  renderModelOptions(document.getElementById('ai-model').value);
  let models = [];
  try { models = await razorAPI.ai.listModels(cfg); } catch {}
  if (reqId !== state.modelsReqId) return; // hubo una detección más nueva: descarto ésta
  state.modelsLoading = false;
  const known = AI_PROVIDERS[provider]?.models || [];
  state.modelOptions = (Array.isArray(models) && models.length) ? models : known;
  renderModelOptions(document.getElementById('ai-model').value);
}

// Rellena el panel a partir de state.aiSettings.
function renderSettings() {
  if (!document.getElementById('ai-provider-select')) return;
  buildProviderOptions();

  const s = state.aiSettings;
  setProviderUI(s.provider);
  document.getElementById('ai-model').value = s.model || '';
  const keyInput = document.getElementById('ai-apikey');
  keyInput.value = s.apiKey || '';
  keyInput.type = 'password';
  document.getElementById('ai-apikey-toggle').classList.remove('revealed');
  const provider = getProviderUI();
  document.getElementById('ai-baseurl').value = s.baseUrl || (AI_PROVIDERS[provider]?.baseUrl || '');
  document.getElementById('ai-system-prompt').value = s.systemPrompt || '';

  state.modelOptions = (AI_PROVIDERS[provider]?.models || []).slice();
  buildToolPerms();
  closeAllDropdowns();
  detectModels();
}

// Construye las filas de permisos por tool (segmento Off / Ask / Allow).
function buildToolPerms() {
  const box = document.getElementById('ai-tool-perms');
  if (!box) return;
  const catalog = razorAPI.toolCatalog || [];
  const perms = state.aiSettings.toolPerms || {};
  const LABELS = { off: 'Off', ask: 'Ask', allow: 'Allow' };
  box.innerHTML = '';
  catalog.forEach(t => {
    const cur = perms[t.name] || t.defaultPerm || 'ask';
    const row = document.createElement('div');
    row.className = 'tool-perm-row' + (t.danger ? ' danger' : '');
    row.dataset.tool = t.name;
    row.innerHTML =
      `<div class="tool-perm-info"><span class="tool-perm-name">${escapeHtml(t.label)}</span>` +
      `<span class="tool-perm-id">${escapeHtml(t.name)}</span></div>` +
      `<div class="tool-perm-seg">` +
        ['off', 'ask', 'allow'].map(p =>
          `<button type="button" data-perm="${p}"${p === cur ? ' class="active"' : ''}>${LABELS[p]}</button>`).join('') +
      `</div>`;
    row.querySelectorAll('.tool-perm-seg button').forEach(btn => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.tool-perm-seg button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    box.appendChild(row);
  });
}
// Lee los permisos elegidos en la UI (merge sobre los actuales, por si el catálogo
// del preload no coincidiera con lo renderizado).
function collectToolPerms() {
  const box = document.getElementById('ai-tool-perms');
  const perms = { ...(state.aiSettings.toolPerms || {}) };
  if (box) box.querySelectorAll('.tool-perm-row').forEach(row => {
    const active = row.querySelector('.tool-perm-seg button.active');
    if (active) perms[row.dataset.tool] = active.dataset.perm;
  });
  return perms;
}

function saveSettings() {
  const provider = getProviderUI();
  state.aiSettings = {
    provider,
    model: document.getElementById('ai-model').value.trim(),
    apiKey: document.getElementById('ai-apikey').value.trim(),
    baseUrl: document.getElementById('ai-baseurl').value.trim() || (AI_PROVIDERS[provider]?.baseUrl || ''),
    systemPrompt: document.getElementById('ai-system-prompt').value,
    toolPerms: collectToolPerms(),
  };
  persistAISettings();
  showSettingsStatus('Settings saved', false);
}

function showSettingsStatus(text, isErr) {
  const el = document.getElementById('ai-settings-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ========== EVENT LISTENERS ========== */
function setupEvents() {
  // Window controls
  document.getElementById('win-min').addEventListener('click', () => razorAPI.minimize());
  document.getElementById('win-close').addEventListener('click', () => razorAPI.close());

  // New tab button
  document.getElementById('new-tab').addEventListener('click', () => createTab());

  // Sidebar
  document.getElementById('open-palette').addEventListener('click', openPalette);
  document.querySelectorAll('.side-icon[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
  document.querySelectorAll('.panel-close').forEach(btn => {
    btn.addEventListener('click', () => switchView('sessions'));
  });

  // Snippets
  document.getElementById('snippet-save').addEventListener('click', addSnippet);
  document.getElementById('snippet-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('snippet-cmd').focus(); }
  });
  document.getElementById('snippet-cmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addSnippet(); }
  });

  // History
  document.getElementById('history-clear').addEventListener('click', clearHistory);

  // Settings (AI agent)
  document.getElementById('ai-settings-save').addEventListener('click', saveSettings);
  // Ojito revelar/ocultar API key: ojo abierto = "revelar", ojo tachado = "ocultar".
  document.getElementById('ai-apikey-toggle').addEventListener('click', () => {
    const inp = document.getElementById('ai-apikey');
    const btn = document.getElementById('ai-apikey-toggle');
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    btn.classList.toggle('revealed', reveal);
    // Transición de revelación/censura: blur rápido que "enfoca" el texto.
    inp.classList.remove('key-anim');
    void inp.offsetWidth; // reinicia la animación si se togglea rápido
    inp.classList.add('key-anim');
    inp.addEventListener('animationend', () => inp.classList.remove('key-anim'), { once: true });
  });
  // Provider dropdown (custom).
  document.getElementById('ai-provider-trigger').addEventListener('click', () => {
    toggleDropdown(document.getElementById('ai-provider-select'));
  });
  // Model combobox (custom + autodetección).
  const modelInput = document.getElementById('ai-model');
  document.getElementById('ai-model-toggle').addEventListener('click', toggleModelCombo);
  modelInput.addEventListener('focus', openModelCombo);
  modelInput.addEventListener('input', () => {
    document.getElementById('ai-model-combo').classList.add('open');
    renderModelOptions(modelInput.value);
  });
  // Re-detectar modelos cuando cambian la key o la base URL (al perder foco).
  document.getElementById('ai-apikey').addEventListener('change', detectModels);
  document.getElementById('ai-baseurl').addEventListener('change', detectModels);
  // Cerrar dropdowns al hacer click afuera.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.rz-select') && !e.target.closest('.rz-combo')) closeAllDropdowns();
  });

  // Bottom bar
  document.getElementById('apply-fix').addEventListener('click', () => {
    addAIMessage('Analyzing the error to suggest a fix…', 'ai');
    hideBottomBar();
  });
  document.getElementById('dismiss-fix').addEventListener('click', hideBottomBar);

  // AI dock
  document.getElementById('ai-send').addEventListener('click', sendAIMessage);
  document.getElementById('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAIMessage();
  });
  // Al terminar de colapsar/expandir el dock, re-ajustar el terminal para que
  // use (o libere) el espacio. Filtramos por 'height' para hacerlo una sola vez.
  document.getElementById('ai-dock').addEventListener('transitionend', (e) => {
    if (e.propertyName !== 'height') return;
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab?.fitAddon) tab.fitAddon.fit();
  });

  // Command palette
  document.getElementById('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  document.getElementById('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteSelection(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); executePaletteItem(state.paletteSelected); }
  });
  document.getElementById('palette-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'palette-overlay') closePalette();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape cierra cualquier dropdown de settings abierto (no interrumpe lo demás).
    if (e.key === 'Escape') closeAllDropdowns();
    // Ctrl+Shift+P → Command palette
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      if (state.paletteOpen) closePalette();
      else openPalette();
      return;
    }
    // Ctrl+T → New tab
    if (e.ctrlKey && !e.shiftKey && e.key === 't') {
      e.preventDefault();
      createTab();
      return;
    }
    // Ctrl+W → Close tab
    if (e.ctrlKey && !e.shiftKey && e.key === 'w') {
      e.preventDefault();
      closeTab(state.activeTabId);
      return;
    }
    // Ctrl+Shift+A → Toggle AI dock
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAIDock();
      return;
    }
    // Ctrl+L → Clear
    if (e.ctrlKey && !e.shiftKey && e.key === 'l') {
      e.preventDefault();
      clearTerminal();
      return;
    }
    // Escape → close palette
    if (e.key === 'Escape' && state.paletteOpen) {
      closePalette();
      return;
    }
  });

  // Focus terminal when window gains focus (clicking taskbar, alt-tab, hotkey, etc.)
  window.addEventListener('focus', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    // Solo re-enfocamos si el cursor ya se reveló (no mostrarlo antes del prompt).
    if (tab?.term && tab.cursorRevealed) tab.term.focus();
  });

  // Resize handler
  window.addEventListener('resize', () => {
    state.tabs.forEach(tab => {
      if (tab.fitAddon) tab.fitAddon.fit();
    });
  });
}

/* ========== DISABLE NATIVE TOOLTIPS ========== */
/* Los tooltips nativos salen del atributo `title` y no se pueden desactivar por
   CSS. Los sacamos de todo el DOM y observamos por si se agregan dinámicamente
   (tabs, snippets, history, palette, etc.). */
function disableTooltips() {
  const strip = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute('title')) node.removeAttribute('title');
    node.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));
  };
  strip(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        if (m.target.nodeType === 1 && m.target.hasAttribute('title')) m.target.removeAttribute('title');
      } else {
        m.addedNodes.forEach(strip);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
}

/* ========== INIT ========== */
function init() {
  console.log('[RAZOR] init() called');
  disableTooltips();
  loadSnippets();
  loadAISettings();
  try {
    setupEvents();
    console.log('[RAZOR] setupEvents() done');
  } catch (err) {
    console.error('[RAZOR] setupEvents() FAILED:', err);
  }
  try {
    createTab('shell 1');
    console.log('[RAZOR] createTab() done');
  } catch (err) {
    console.error('[RAZOR] createTab() FAILED:', err);
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// DOM is already parsed (script is at end of body), just init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}