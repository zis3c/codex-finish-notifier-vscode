const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/**
 * Codex Notifier extension runtime state.
 * These variables keep watcher/timer handles and burst tracking so we can
 * reliably detect "response complete" without duplicate notifications.
 */
let watcher = null;
let codexDocWatcher = null;
let codexPoller = null;
let codexState = new Map();
let lastCodexNotifyAt = 0;
let debugDocWatcher = null;
let output = null;
let codexLogPoller = null;
let codexLogIdleTimer = null;
let codexLogOffsets = new Map();
let codexLogPending = false;
let codexLogFirstActivityAt = 0;
let codexLogLastActivityAt = 0;
let codexLogActivityCount = 0;
let codexLogBurstNotified = false;
let codexLogMaybeDoneAt = 0;
let statusItem = null;
let statusTimer = null;

// Small helper for readable timestamps in diagnostics output.
function fmtTs(ms) {
  if (!ms) return "n/a";
  return new Date(ms).toISOString();
}

// Snapshot current runtime and config values for quick troubleshooting.
function getDiagnosticsSummary() {
  const cfg = getConfig();
  return {
    monitorCodexLog: cfg.get("monitorCodexLog", true),
    monitorCodexChat: cfg.get("monitorCodexChat", true),
    codexLogPollMs: cfg.get("codexLogPollMs", 700),
    codexLogIdleMs: cfg.get("codexLogIdleMs", 1400),
    codexChatCooldownMs: cfg.get("codexChatCooldownMs", 5000),
    codexLogMinEvents: cfg.get("codexLogMinEvents", 3),
    codexLogMinBurstMs: cfg.get("codexLogMinBurstMs", 500),
    volume: cfg.get("volume", 1),
    trackedLogFiles: codexLogOffsets.size,
    pending: codexLogPending,
    activityCount: codexLogActivityCount,
    firstActivityAt: fmtTs(codexLogFirstActivityAt),
    lastActivityAt: fmtTs(codexLogLastActivityAt),
    lastNotifyAt: fmtTs(lastCodexNotifyAt)
  };
}

// Main extension settings namespace.
function getConfig() {
  return vscode.workspace.getConfiguration("codexNotifier");
}

// Lazily create output channel used for debug/diagnostic logs.
function getOutput() {
  if (!output) {
    output = vscode.window.createOutputChannel("Codex Notifier");
  }
  return output;
}

// Debug logger guarded by `codexNotifier.debug` setting.
function logDebug(message) {
  const cfg = getConfig();
  if (!cfg.get("debug", false)) return;
  const ts = new Date().toISOString();
  getOutput().appendLine(`[${ts}] ${message}`);
}

// Quiet UI feedback (status bar), used instead of intrusive info banners.
function showQuickStatus(message, kind) {
  const config = getConfig();
  const popupMsRaw = config.get("popupDurationMs", 1800);
  const popupMs = Number.isFinite(popupMsRaw) ? Math.max(300, popupMsRaw) : 1800;

  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  }

  statusItem.text = kind === "error" ? `$(error) ${message}` : `$(check) ${message}`;
  statusItem.tooltip = "Codex Notifier";
  statusItem.show();

  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  statusTimer = setTimeout(() => {
    statusItem?.hide();
    statusTimer = null;
  }, popupMs);
}

// Optional Windows toast helper (kept for compatibility, currently quiet mode uses status bar).
function showWindowsToast(title, message) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve();
      return;
    }

    const esc = (s) => String(s).replace(/'/g, "''");
    const t = esc(title);
    const m = esc(message);
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;",
      `$xml = @'<toast><visual><binding template=\"ToastGeneric\"><text>${t}</text><text>${m}</text></binding></visual></toast>'@;`,
      "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument;",
      "$doc.LoadXml($xml);",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc);",
      "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Codex Notifier');",
      "$notifier.Show($toast);"
    ].join(" ");

    execFile("powershell.exe", ["-NoProfile", "-Command", script], () => resolve());
  });
}

// Resolve watched trigger file path from workspace-relative config.
function resolveWatchPath(rawPath) {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.join(folder, rawPath);
}

// Fallback alert tone when no custom sound file is configured.
function playSystemBeep() {
  process.stdout.write("\u0007");
}

// Resolve configured sound file path, else use bundled notification.wav if present.
function resolveSoundPath(configuredPath, kind = "complete") {
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  // Kind-specific bundled defaults for users installing via VSIX.
  if (kind === "error") {
    const bundledError = path.join(__dirname, "notification1.wav");
    if (fs.existsSync(bundledError)) {
      return bundledError;
    }
  } else {
    const bundledComplete = path.join(__dirname, "notification2.wav");
    if (fs.existsSync(bundledComplete)) {
      return bundledComplete;
    }
  }

  // Backward compatibility fallback.
  const bundledLegacy = path.join(__dirname, "notification.wav");
  if (fs.existsSync(bundledLegacy)) {
    return bundledLegacy;
  }

  return "";
}

// Cross-platform sound player wrapper with Windows-first implementation.
function playSound(filePath, volume) {
  return new Promise((resolve) => {
    if (!filePath) {
      playSystemBeep();
      resolve();
      return;
    }

    const safeVolume = Number.isFinite(volume) ? String(Math.max(0, Math.min(1, volume))) : "1";

    if (process.platform === "win32") {
      const escapedPath = filePath.replace(/'/g, "''");
      const ext = path.extname(filePath).toLowerCase();

      // WAV playback via SoundPlayer is most reliable on Windows.
      if (ext === ".wav") {
        const script = [
          `if (-not (Test-Path -LiteralPath '${escapedPath}')) { exit 1 }`,
          `$p = New-Object System.Media.SoundPlayer '${escapedPath}';`,
          "$p.PlaySync();"
        ].join(" ");

        execFile("powershell.exe", ["-NoProfile", "-Command", script], (err) => {
          if (err) playSystemBeep();
          resolve();
        });
        return;
      }

      const script = [
        "Add-Type -AssemblyName presentationCore;",
        `if (-not (Test-Path -LiteralPath '${escapedPath}')) { exit 1 }`,
        `$resolved = (Resolve-Path -LiteralPath '${escapedPath}').Path;`,
        "$u = New-Object System.Uri($resolved);",
        "$p = New-Object system.windows.media.mediaplayer;",
        "$p.Open($u);",
        `$p.Volume = ${safeVolume};`,
        "$p.Play();",
        "Start-Sleep -Milliseconds 1400;",
        "$p.Close();"
      ].join(" ");

      execFile("powershell.exe", ["-NoProfile", "-Command", script], (err) => {
        if (err) playSystemBeep();
        resolve();
      });
      return;
    }

    if (process.platform === "darwin") {
      execFile("afplay", [filePath], () => resolve());
      return;
    }

    execFile("paplay", [filePath], () => resolve());
  });
}

/**
 * Main notification primitive.
 * - `kind`: "complete" or "error"
 * - `message`: user-facing text
 * - `options`: reserved for future mode flags
 */
async function notify(kind, message, options = {}) {
  const config = getConfig();
  const enablePopup = config.get("enablePopup", true);
  const completionUseBanner = config.get("completionUseBanner", false);
  const toastWhenUnfocused = config.get("toastWhenUnfocused", true);
  const enableSound = config.get("enableSound", true);
  const volumeRaw = config.get("volume", 1);
  const volume = Number.isFinite(volumeRaw) ? Math.max(0, Math.min(1, volumeRaw)) : 1;
  const completeSoundPath = config.get("completeSoundPath", "");
  const errorSoundPath = config.get("errorSoundPath", "");

  if (enablePopup) {
    if (kind === "error") {
      vscode.window.showErrorMessage(message);
    } else {
      if (completionUseBanner) {
        if (toastWhenUnfocused && process.platform === "win32" && !vscode.window.state.focused) {
          await showWindowsToast("Codex Notifier", message);
        } else {
          vscode.window.showInformationMessage(message);
        }
      } else {
        // Quiet mode: hide banner and show only status bar.
        showQuickStatus(message, kind);
      }
    }
  }

  if (enableSound) {
    const preferredPath = kind === "error" ? errorSoundPath : completeSoundPath;
    const soundPath = resolveSoundPath(preferredPath, kind);
    await playSound(soundPath, volume);
  }
}

// Stop file watcher trigger (".codex-notify").
function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// Stop Codex document-based monitoring.
function stopCodexDocumentWatcher() {
  if (codexDocWatcher) {
    codexDocWatcher.dispose();
    codexDocWatcher = null;
  }

  if (codexPoller) {
    clearInterval(codexPoller);
    codexPoller = null;
  }
  codexState.clear();
  if (debugDocWatcher) {
    debugDocWatcher.dispose();
    debugDocWatcher = null;
  }
}

// Stop Codex.log-based monitoring and reset burst state.
function stopCodexLogWatcher() {
  if (codexLogPoller) {
    clearInterval(codexLogPoller);
    codexLogPoller = null;
  }
  if (codexLogIdleTimer) {
    clearInterval(codexLogIdleTimer);
    codexLogIdleTimer = null;
  }
  codexLogOffsets.clear();
  codexLogPending = false;
  codexLogFirstActivityAt = 0;
  codexLogLastActivityAt = 0;
  codexLogActivityCount = 0;
  codexLogBurstNotified = false;
  codexLogMaybeDoneAt = 0;
}

function getCodexLogRoots() {
  const roots = [];
  if (process.platform === "win32") {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "Code", "logs"));
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "Cursor", "logs"));
    return roots;
  }

  const home = process.env.HOME;
  if (!home) return roots;
  roots.push(path.join(home, ".config", "Code", "logs"));
  roots.push(path.join(home, ".config", "Cursor", "logs"));
  return roots;
}

// Find recent Codex.log files across VS Code log sessions/windows.
function findAllCodexLogFiles() {
  const candidates = [];
  const roots = getCodexLogRoots();
  for (const logsRoot of roots) {
    if (!fs.existsSync(logsRoot)) continue;
    try {
      const sessions = fs.readdirSync(logsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const session of sessions) {
        const sessionPath = path.join(logsRoot, session.name);
        const windows = fs.readdirSync(sessionPath, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("window"));
        for (const win of windows) {
          const codexLog = path.join(sessionPath, win.name, "exthost", "openai.chatgpt", "Codex.log");
          if (!fs.existsSync(codexLog)) continue;
          const stat = fs.statSync(codexLog);
          candidates.push({ file: codexLog, mtimeMs: stat.mtimeMs });
        }
      }
    } catch {
      // noop
    }
  }

  // Keep only recently-touched files to avoid stale sessions.
  const now = Date.now();
  const recent = candidates.filter((c) => now - c.mtimeMs <= 1000 * 60 * 120); // 2h
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Track all recent windows so the active Codex session is not missed.
  return recent.map((c) => c.file);
}

function isLikelyCodexDocument(doc) {
  if (!doc || !doc.uri) return false;
  const scheme = String(doc.uri.scheme || "").toLowerCase();
  const uri = String(doc.uri.toString() || "").toLowerCase();
  if (scheme === "openai-codex") return true;
  if (scheme.includes("codex")) return true;
  if (uri.includes("openai-codex")) return true;
  return false;
}

/**
 * Log-based completion detector.
 * Strategy:
 * 1) track stream-state activity bursts
 * 2) wait until burst goes idle
 * 3) require read-state signal to avoid noise-triggered spam
 * 4) enforce cooldown + per-burst dedupe
 */
function startCodexLogWatcher() {
  stopCodexLogWatcher();

  const cfg = getConfig();
  const enabled = cfg.get("monitorCodexLog", true);
  if (!enabled) return;

  const pollMsRaw = cfg.get("codexLogPollMs", 300);
  const idleMsRaw = cfg.get("codexLogIdleMs", 700);
  const cooldownMsRaw = cfg.get("codexChatCooldownMs", 4500);
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(300, pollMsRaw) : 700;
  const idleMs = Number.isFinite(idleMsRaw) ? Math.max(300, idleMsRaw) : 1400;
  const cooldownMs = Number.isFinite(cooldownMsRaw) ? Math.max(0, cooldownMsRaw) : 4500;

  codexLogPoller = setInterval(async () => {
    const files = findAllCodexLogFiles();
    if (!files || files.length === 0) return;

    const live = new Set(files);
    for (const known of Array.from(codexLogOffsets.keys())) {
      if (!live.has(known)) {
        codexLogOffsets.delete(known);
      }
    }

    for (const file of files) {
      try {
        let offset = codexLogOffsets.get(file);
        const stat = fs.statSync(file);
        if (offset == null) {
          // Tail mode: begin at end; only process new lines from now on.
          codexLogOffsets.set(file, stat.size);
          logDebug(`tail start file=${file} offset=${stat.size}`);
          continue;
        }
        if (stat.size < offset) offset = 0;
        if (stat.size === offset) {
          codexLogOffsets.set(file, offset);
          continue;
        }

        const fd = fs.openSync(file, "r");
        const len = stat.size - offset;
        const buffer = Buffer.alloc(len);
        fs.readSync(fd, buffer, 0, len, offset);
        fs.closeSync(fd);
        codexLogOffsets.set(file, stat.size);

        const chunk = buffer.toString("utf8");
        const now = Date.now();
        const streamHits = (chunk.match(/thread-stream-state-changed/g) || []).length;
        const readHits = (chunk.match(/thread-read-state-changed/g) || []).length;
        const hitCount = streamHits;
        if (hitCount > 0) {
          if (!codexLogPending || (now - codexLogLastActivityAt > idleMs)) {
            codexLogFirstActivityAt = now;
            codexLogActivityCount = 0;
            codexLogBurstNotified = false;
            codexLogMaybeDoneAt = 0;
          }
          codexLogPending = true;
          codexLogLastActivityAt = now;
          codexLogActivityCount += hitCount;
          logDebug(`codex thread activity file=${file} hits=${hitCount} total=${codexLogActivityCount}`);
        }

        // Read-state is "maybe done", but we still wait a short quiet grace period
        // to avoid notifying before final visible tokens land.
        if (readHits > 0 && codexLogPending && !codexLogBurstNotified) {
          codexLogMaybeDoneAt = now;
          logDebug(`read-state seen; waiting for quiet grace hits=${readHits}`);
        }
      } catch {
        // noop
      }
    }
  }, pollMs);

  codexLogIdleTimer = setInterval(async () => {
    const now = Date.now();
    if (!codexLogPending) return;
    if (now - codexLogLastActivityAt < idleMs) return;
    // Ignore noisy bursts that never reached read-state completion signal.
    if (!codexLogMaybeDoneAt) {
      logDebug(`reset quiet logs without read-state count=${codexLogActivityCount}`);
      codexLogPending = false;
      codexLogFirstActivityAt = 0;
      codexLogLastActivityAt = 0;
      codexLogActivityCount = 0;
      codexLogBurstNotified = false;
      codexLogMaybeDoneAt = 0;
      return;
    }
    const graceMs = 350;
    if (codexLogMaybeDoneAt && now - codexLogMaybeDoneAt < graceMs) return;

    const notCoolingDown = now - lastCodexNotifyAt >= cooldownMs;
    const activityDurationMs = codexLogLastActivityAt - codexLogFirstActivityAt;
    if (notCoolingDown && !codexLogBurstNotified) {
      lastCodexNotifyAt = now;
      codexLogBurstNotified = true;
      logDebug(`notify complete from quiet logs count=${codexLogActivityCount} durMs=${activityDurationMs}`);
      await notify("complete", "Codex: response complete", { mode: "auto" });
    } else {
      logDebug(`reset quiet logs cooling=${notCoolingDown} durMs=${activityDurationMs} count=${codexLogActivityCount}`);
    }

    codexLogPending = false;
    codexLogFirstActivityAt = 0;
    codexLogLastActivityAt = 0;
    codexLogActivityCount = 0;
    codexLogBurstNotified = false;
    codexLogMaybeDoneAt = 0;
  }, Math.min(500, Math.max(250, Math.floor(idleMs / 3))));
}

/**
 * Document-based fallback detector for openai-codex docs.
 * Useful when log signals are missing/unreliable in some environments.
 */
function startCodexDocumentWatcher(context) {
  stopCodexDocumentWatcher();

  const config = getConfig();
  const enabled = config.get("monitorCodexChat", true);
  if (!enabled) return;

  const idleMsRaw = config.get("codexChatIdleMs", 1800);
  const cooldownMsRaw = config.get("codexChatCooldownMs", 5000);
  const pollMsRaw = config.get("codexChatPollMs", 600);
  const idleMs = Number.isFinite(idleMsRaw) ? Math.max(500, idleMsRaw) : 1800;
  const cooldownMs = Number.isFinite(cooldownMsRaw) ? Math.max(0, cooldownMsRaw) : 5000;
  const pollMs = Number.isFinite(pollMsRaw) ? Math.max(250, pollMsRaw) : 600;

  const touchDocument = (doc) => {
    if (!isLikelyCodexDocument(doc)) return;
    const key = doc.uri.toString();
    const textLen = doc.getText().length;
    const now = Date.now();
    const prev = codexState.get(key);

    if (!prev) {
      codexState.set(key, {
        textLen,
        lastChangeAt: now,
        notifiedForThisBurst: false
      });
      return;
    }

    if (textLen !== prev.textLen) {
      prev.textLen = textLen;
      prev.lastChangeAt = now;
      prev.notifiedForThisBurst = false;
    }
  };

  const maybeNotify = async () => {
    const now = Date.now();

    for (const state of codexState.values()) {
      if (state.notifiedForThisBurst) continue;
      if (now - state.lastChangeAt < idleMs) continue;
      if (now - lastCodexNotifyAt < cooldownMs) continue;

      state.notifiedForThisBurst = true;
      lastCodexNotifyAt = now;
      logDebug("notify complete from Codex activity detector");
      await notify("complete", "Codex: response complete");
      break;
    }
  };

  codexDocWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
    logDebug(`text change: scheme=${event.document.uri.scheme}`);
    touchDocument(event.document);
  });

  debugDocWatcher = vscode.workspace.onDidOpenTextDocument((doc) => {
    logDebug(`document opened: scheme=${doc.uri.scheme} uri=${doc.uri.toString()}`);
  });

  // Polling catches Codex custom-editor updates that may not emit normal text change events.
  codexPoller = setInterval(async () => {
    const docs = vscode.workspace.textDocuments.filter((d) => isLikelyCodexDocument(d));
    logDebug(`poll tick: totalDocs=${vscode.workspace.textDocuments.length} codexDocs=${docs.length}`);
    for (const doc of docs) {
      touchDocument(doc);
    }
    await maybeNotify();
  }, pollMs);

  context.subscriptions.push(codexDocWatcher);
  context.subscriptions.push(debugDocWatcher);
  context.subscriptions.push({ dispose: () => { if (codexPoller) clearInterval(codexPoller); codexPoller = null; } });
  context.subscriptions.push({ dispose: stopCodexDocumentWatcher });
}

// File-trigger watcher: write to `.codex-notify` to manually signal complete/error.
function startWatcher(context) {
  stopWatcher();

  const config = getConfig();
  const enabled = config.get("watchEnabled", true);
  if (!enabled) return;

  const rawPath = config.get("watchFilePath", ".codex-notify");
  const targetPath = resolveWatchPath(rawPath);
  if (!targetPath) return;

  try {
    if (!fs.existsSync(targetPath)) {
      logDebug(`watch file missing, manual trigger disabled until file exists: ${targetPath}`);
      return;
    }

    let lastContent = fs.readFileSync(targetPath, "utf8");

    watcher = fs.watch(targetPath, { persistent: false }, async () => {
      try {
        const next = fs.readFileSync(targetPath, "utf8");
        if (next === lastContent) return;
        lastContent = next;

        const trimmed = next.trim().toLowerCase();
        if (!trimmed) return;

        if (trimmed.includes("error")) {
          await notify("error", "Codex: task error", { mode: "manual" });
        } else {
          await notify("complete", "Codex: response complete", { mode: "manual" });
        }
      } catch {
        // noop
      }
    });

    context.subscriptions.push({ dispose: stopWatcher });
  } catch {
    // noop
  }
}

async function maybeShowPostUpdateReloadHint(context) {
  try {
    const ext = vscode.extensions.getExtension("local.codex-notifier");
    const currentVersion = ext?.packageJSON?.version;
    if (!currentVersion) return;

    const key = "codexNotifier.lastSeenVersion";
    const lastSeenVersion = context.globalState.get(key);

    // First run: store and skip prompt.
    if (!lastSeenVersion) {
      await context.globalState.update(key, currentVersion);
      return;
    }

    // Version changed: recommend reload for bundled asset consistency.
    if (lastSeenVersion !== currentVersion) {
      await context.globalState.update(key, currentVersion);
      const action = "Reload Window";
      const pick = await vscode.window.showInformationMessage(
        `Codex Notifier updated to v${currentVersion}. Reload VS Code to ensure bundled sounds are loaded correctly.`,
        action
      );
      if (pick === action) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  } catch {
    // noop
  }
}

// Extension activation: register commands, config change handlers, and watchers.
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.notifyComplete", async () => {
      await notify("complete", "Codex: response complete", { mode: "manual" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.notifyError", async () => {
      await notify("error", "Codex: task error", { mode: "manual" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.testSound", async () => {
      await notify("complete", "Codex Notifier: test sound", { mode: "manual" });
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.debugSnapshot", async () => {
      const docs = vscode.workspace.textDocuments.map((d) => `${d.uri.scheme} :: ${d.uri.toString()}`);
      const editors = vscode.window.visibleTextEditors.map((e) => `${e.document.uri.scheme} :: ${e.document.uri.toString()}`);
      const out = getOutput();
      out.appendLine("===== Snapshot =====");
      out.appendLine(`docs(${docs.length})`);
      docs.forEach((d) => out.appendLine(`  ${d}`));
      out.appendLine(`visibleEditors(${editors.length})`);
      editors.forEach((e) => out.appendLine(`  ${e}`));
      out.show(true);
      vscode.window.showInformationMessage("Codex Notifier: debug snapshot written to output.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.toggleAutoNotify", async () => {
      const cfg = getConfig();
      const current = cfg.get("monitorCodexLog", true);
      await cfg.update("monitorCodexLog", !current, vscode.ConfigurationTarget.Workspace);
      const next = !current;
      if (next) {
        startCodexLogWatcher();
      } else {
        stopCodexLogWatcher();
      }
      vscode.window.showInformationMessage(`Codex Notifier: auto notify ${next ? "enabled" : "disabled"}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexNotifier.showDiagnostics", async () => {
      const summary = getDiagnosticsSummary();
      const out = getOutput();
      out.appendLine("===== Diagnostics =====");
      Object.entries(summary).forEach(([k, v]) => out.appendLine(`${k}: ${v}`));
      out.show(true);
      vscode.window.showInformationMessage(
        `Codex Notifier: pending=${summary.pending} logs=${summary.trackedLogFiles} lastNotify=${summary.lastNotifyAt}`
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexNotifier")) {
        startWatcher(context);
        startCodexDocumentWatcher(context);
        startCodexLogWatcher();
      }
    })
  );

  startWatcher(context);
  startCodexDocumentWatcher(context);
  startCodexLogWatcher();
  void maybeShowPostUpdateReloadHint(context);
  logDebug("activated");
}

// Extension shutdown cleanup.
function deactivate() {
  stopWatcher();
  stopCodexDocumentWatcher();
  stopCodexLogWatcher();
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  statusItem?.dispose();
  statusItem = null;
}

module.exports = {
  activate,
  deactivate
};
