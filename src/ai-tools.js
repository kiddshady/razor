// Herramientas del agente de IA: lectura de filesystem (read_file/list_dir/path_info)
// y ejecución de comandos (shell_exec/cmd_exec, marcadas peligrosas: piden confirmación).
// Se separa de main.js para poder testear la lógica sin arrancar Electron.
const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const { execFile } = require('child_process');

// Definición agnóstica del proveedor (formato Anthropic: name/description/
// input_schema). Para OpenAI se envuelve como {type:'function', function:{...}}.
const AI_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a UTF-8 text file on the user\'s machine (config files, shell profiles, scripts, source code, etc.). Large files are truncated; binary files are not returned.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or path relative to the current terminal directory. A leading ~ expands to the home directory.' },
        offset: { type: 'number', description: 'Optional 1-based line number to start reading from.' },
        limit: { type: 'number', description: 'Optional maximum number of lines to read starting at offset.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries (files and sub-folders, with sizes) of a directory on the user\'s machine.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or path relative to the current terminal directory. ~ expands to home. Defaults to the current terminal directory.' },
      },
      required: [],
    },
  },
  {
    name: 'path_info',
    description: 'Get metadata about a filesystem path: whether it exists, its type (file/directory), size in bytes, and last-modified time.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or path relative to the current terminal directory. ~ expands to home.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'shell_exec',
    description: 'Run a command in PowerShell (pwsh) on the user\'s machine and return its stdout, stderr and exit code. Use for PowerShell cmdlets and scripts. DANGEROUS: this can modify the system — only use it when the user clearly wants an action performed.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command line to execute.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'cmd_exec',
    description: 'Run a command in the classic Windows Command Prompt (cmd.exe) and return its stdout, stderr and exit code. DANGEROUS: this can modify the system — only use it when the user clearly wants an action performed.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The cmd.exe command line to execute.' },
      },
      required: ['command'],
    },
  },
];

// Catálogo para la UI de permisos (label legible, si es peligrosa, permiso default).
// Fuente única de verdad: el renderer lo consume vía preload para no desincronizar.
const TOOL_CATALOG = [
  { name: 'read_file',  label: 'Read file',       danger: false, defaultPerm: 'allow' },
  { name: 'list_dir',   label: 'List directory',  danger: false, defaultPerm: 'allow' },
  { name: 'path_info',  label: 'Path info',       danger: false, defaultPerm: 'allow' },
  { name: 'shell_exec', label: 'Run PowerShell',  danger: true,  defaultPerm: 'ask'   },
  { name: 'cmd_exec',   label: 'Run cmd.exe',     danger: true,  defaultPerm: 'ask'   },
];
const DEFAULT_TOOL_PERMS = Object.fromEntries(TOOL_CATALOG.map(t => [t.name, t.defaultPerm]));

// OpenAI-compatible espera las tools envueltas en {type:'function', function:{...}}.
const OPENAI_TOOLS = AI_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

const MAX_READ_BYTES = 100 * 1024; // techo de lectura por archivo (100 KB)
const MAX_DIR_ENTRIES = 300;       // techo de entradas listadas por carpeta
const EXEC_TIMEOUT_MS = 30000;     // corte por comando (30 s)
const EXEC_MAX_BUFFER = 1024 * 1024; // buffer máx de stdout/stderr (1 MB)
const MAX_EXEC_OUTPUT = 30 * 1024; // recorte de salida devuelta al modelo (30 KB)

// Resuelve un path del usuario: expande ~, y si es relativo lo ancla al cwd del
// terminal (o al home si el cwd no está disponible).
function resolveUserPath(p, baseCwd) {
  const home = os.homedir();
  if (!p || !p.trim()) return baseCwd || home;
  let out = p.trim();
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(2));
  if (!path.isAbsolute(out)) out = path.resolve(baseCwd || home, out);
  return path.normalize(out);
}

// Ejecuta una tool de lectura. Devuelve { ok, content } — nunca lanza: los errores
// se devuelven como texto para que el modelo pueda reaccionar (archivo inexistente,
// permisos, etc.).
async function executeTool(name, input, context) {
  const home = os.homedir();
  const baseCwd = (context && context.cwd && context.cwd !== '~') ? context.cwd : home;
  try {
    if (name === 'read_file')  return await toolReadFile(input || {}, baseCwd);
    if (name === 'list_dir')   return await toolListDir(input || {}, baseCwd);
    if (name === 'path_info')  return await toolPathInfo(input || {}, baseCwd);
    if (name === 'shell_exec') return await runCommand('shell', input || {}, baseCwd);
    if (name === 'cmd_exec')   return await runCommand('cmd', input || {}, baseCwd);
    return { ok: false, content: `Unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, content: `Error: ${(err.code ? err.code + ' ' : '') + err.message}`.trim() };
  }
}

// Ejecuta un comando en PowerShell (kind='shell') o cmd.exe (kind='cmd') en un
// proceso hijo aislado (NO en la terminal interactiva del usuario), captura
// stdout/stderr/exit code, con timeout y truncado. Corre en el cwd del terminal.
function runCommand(kind, input, baseCwd) {
  const command = (input.command || '').trim();
  if (!command) return Promise.resolve({ ok: false, content: 'No command provided.' });
  const isWin = process.platform === 'win32';
  let file, args, label;
  if (kind === 'cmd') {
    label = 'cmd.exe';
    file = isWin ? 'cmd.exe' : '/bin/sh';
    args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
  } else {
    label = 'PowerShell';
    file = isWin ? 'pwsh.exe' : '/bin/bash';
    args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
  }
  return new Promise((resolve) => {
    execFile(file, args, { cwd: baseCwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
      const out = clip((stdout || '').toString());
      const errOut = clip((stderr || '').toString());
      if (err && err.killed) return resolve({ ok: false, content: `Command timed out after ${EXEC_TIMEOUT_MS / 1000}s and was killed.\n${out}${errOut}` });
      if (err && typeof err.code !== 'number') return resolve({ ok: false, content: `Could not run command: ${err.message}` });
      const code = err ? err.code : 0; // exit code (nonzero NO es error de la tool: el comando corrió)
      let content = `$ ${command}\n[${label}] exit code: ${code}`;
      if (out) content += `\n--- stdout ---\n${out}`;
      if (errOut) content += `\n--- stderr ---\n${errOut}`;
      if (!out && !errOut) content += `\n(no output)`;
      resolve({ ok: true, content });
    });
  });
}
function clip(s) { return s.length > MAX_EXEC_OUTPUT ? s.slice(0, MAX_EXEC_OUTPUT) + '\n… [output truncated]' : s; }

async function toolReadFile(input, baseCwd) {
  const full = resolveUserPath(input.path, baseCwd);
  const st = await fsp.stat(full);
  if (st.isDirectory()) return { ok: false, content: `${full} is a directory, not a file. Use list_dir instead.` };
  const buf = await fsp.readFile(full);
  if (buf.includes(0)) return { ok: false, content: `${full} looks like a binary file (${st.size} bytes) and was not read.` };
  let text = buf.toString('utf8');
  let note = '';
  if (input.offset || input.limit) {
    const lines = text.split('\n');
    const start = Math.max(0, input.offset ? input.offset - 1 : 0);
    const end = input.limit ? start + input.limit : lines.length;
    text = lines.slice(start, end).join('\n');
    note = ` (lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length})`;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) {
    text = text.slice(0, MAX_READ_BYTES);
    note += ` [truncated to ${MAX_READ_BYTES} bytes]`;
  }
  return { ok: true, content: `File: ${full}${note}\n\n${text}` };
}

async function toolListDir(input, baseCwd) {
  const full = resolveUserPath(input.path, baseCwd);
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const lines = await Promise.all(shown.map(async (e) => {
    const kind = e.isDirectory() ? 'dir ' : 'file';
    let size = '';
    if (e.isFile()) { try { size = `  ${(await fsp.stat(path.join(full, e.name))).size}b`; } catch {} }
    return `[${kind}] ${e.name}${size}`;
  }));
  let out = `Directory: ${full} (${entries.length} entries)\n${lines.join('\n')}`;
  if (entries.length > MAX_DIR_ENTRIES) out += `\n… ${entries.length - MAX_DIR_ENTRIES} more not shown`;
  return { ok: true, content: out };
}

async function toolPathInfo(input, baseCwd) {
  const full = resolveUserPath(input.path, baseCwd);
  try {
    const s = await fsp.stat(full);
    const type = s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other';
    return { ok: true, content: `${full}\n- exists: yes\n- type: ${type}\n- size: ${s.size} bytes\n- modified: ${s.mtime.toISOString()}` };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, content: `${full}\n- exists: no` };
    throw err;
  }
}

module.exports = { AI_TOOLS, OPENAI_TOOLS, TOOL_CATALOG, DEFAULT_TOOL_PERMS, resolveUserPath, executeTool };
