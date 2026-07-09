# ===============================================================
# RAZOR — OSC 7 cwd reporting
# ===============================================================
# Emite la cwd actual (secuencia OSC 7) en cada prompt, para que el agente R7
# opere en el directorio REAL del usuario (read_file con paths relativos,
# shell_exec, cmd_exec) en vez de quedar clavado en el cwd inicial.
#
# NO pisa el prompt del usuario: captura el prompt actual y lo ENVUELVE, de modo
# que el prompt visible queda idéntico. Este archivo lo carga RAZOR al abrir la
# terminal (después del core-profile del usuario, que queda intacto).
# ===============================================================

# Foto del prompt vigente (el default de PowerShell, o el que haya definido el
# profile del usuario). Lo llamamos al final para no cambiar la estética.
$global:__RazorInnerPrompt = $function:prompt

function global:prompt {
    # Emitimos OSC 7 sólo si estamos parados en el filesystem (no en HKLM:, etc.).
    try {
        $loc = $ExecutionContext.SessionState.Path.CurrentLocation
        if ($loc -and $loc.Provider.Name -eq 'FileSystem') {
            $uri = ($loc.ProviderPath -replace '\\', '/')
            # ESC ] 7 ; file:///<path> BEL   (BEL = terminador; xterm lo consume)
            [Console]::Write([char]27 + ']7;file:///' + $uri + [char]7)
        }
    } catch { }

    # Devolvemos el prompt original tal cual (o el default si no hubiera).
    if ($global:__RazorInnerPrompt) { & $global:__RazorInnerPrompt }
    else { "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}
