/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, readdir, stat } from "fs/promises";
import { join, dirname, relative } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { getUnreadEmails, formatEmails } from "./gmail.ts";
import { getTodayEvents, formatEvents } from "./calendar.ts";
import { getAccessToken } from "./google-auth.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

// Chat history for context across messages
const HISTORY_FILE = join(TEMP_DIR, "chat_history.json");
const MAX_HISTORY = 20; // keep last N message pairs

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// Active code session (remote Claude Code in a project folder)
interface CodeSession {
  project: string;       // project name under ~/dev
  projectPath: string;   // full path
  sessionId: string | null;
  mode: "prompt" | "remote"; // prompt = relay sends messages, remote = claude.ai/code
  remoteProcess?: ReturnType<typeof spawn> | null;
}

let activeCodeSession: CodeSession | null = null;

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// CHAT HISTORY
// ============================================================

async function loadHistory(): Promise<ChatMessage[]> {
  try {
    const content = await readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function appendHistory(role: "user" | "assistant", content: string): Promise<void> {
  const history = await loadHistory();
  history.push({ role, content, timestamp: new Date().toISOString() });
  // Keep only last MAX_HISTORY messages
  const trimmed = history.slice(-MAX_HISTORY);
  await writeFile(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

async function clearHistory(): Promise<void> {
  await writeFile(HISTORY_FILE, "[]");
  session.sessionId = null;
  await saveSession(session);
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  // Allow MCP tools without confirmation
  args.push(
    "--allowedTools",
    "mcp__relay-tools__check_email,mcp__relay-tools__check_calendar,mcp__relay-tools__create_calendar_event,mcp__relay-tools__web_search,mcp__relay-tools__browse_dev,mcp__relay-tools__get_weather,mcp__relay-tools__create_note,mcp__relay-tools__read_note,mcp__relay-tools__search_notes,mcp__relay-tools__edit_note,mcp__relay-tools__list_notes,mcp__relay-tools__add_to_daily,mcp__relay-tools__get_daily,mcp__relay-tools__update_weekly"
  );

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// ISOLATED CODE SESSION (runs in separate process)
// ============================================================

// Track the running code process so we can kill it
let codeProcess: ReturnType<typeof spawn> | null = null;

async function callClaudeCode(
  prompt: string,
  projectPath: string,
  sessionId?: string | null
): Promise<{ output: string; sessionId: string | null }> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  console.log(`[code-session] ${projectPath}: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectPath,
      env: { ...process.env },
    });

    codeProcess = proc;

    // Race between output and timeout (5 minutes max)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error("Code session timed out (5 min). Send another message to continue."));
      }, 300_000)
    );

    const result = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const [output, stderr, exitCode] = await Promise.race([result, timeout]);
    codeProcess = null;

    if (exitCode !== 0) {
      console.error("[code-session] error:", stderr);
      return { output: `Error: ${stderr || "exit code " + exitCode}`, sessionId };
    }

    // Extract session ID for --resume
    const match = (output as string).match(/Session ID: ([a-f0-9-]+)/i);
    const newSessionId = match ? match[1] : sessionId;

    return { output: (output as string).trim(), sessionId: newSessionId || null };
  } catch (error: any) {
    codeProcess = null;
    console.error("[code-session] spawn error:", error);
    return { output: error.message || "Code session error", sessionId };
  }
}

function killCodeProcess() {
  if (codeProcess) {
    try {
      codeProcess.kill();
    } catch {}
    codeProcess = null;
  }
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

// Configurable paths
const STORAGE_DIR = process.env.STORAGE_DIR || join(process.env.HOME || "~", "storage");
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(process.env.HOME || "~", "dev", "obsidian");

// Register commands with Telegram (autocomplete in the chat input)
bot.api.setMyCommands([
  { command: "help", description: "Show all capabilities" },
  { command: "status", description: "Services, connections, and features" },
  { command: "code", description: "Start code session in ~/dev project" },
  { command: "files", description: "Browse, upload, download files" },
  { command: "note", description: "Create an Obsidian note" },
  { command: "notes", description: "Search Obsidian vault" },
  { command: "email", description: "Check Gmail inbox" },
  { command: "calendar", description: "Today's calendar events" },
  { command: "sync", description: "Sync Obsidian vault via Git" },
  { command: "links", description: "Access URLs for Pi services" },
  { command: "service", description: "Start/stop/restart services" },
  { command: "search", description: "Search the web" },
  { command: "dev", description: "Browse ~/dev projects" },
  { command: "clear", description: "Clear chat history" },
  { command: "reset", description: "Full reset — nuke all sessions" },
]).catch(() => {});

// ============================================================
// GIT SYNC
// ============================================================

async function gitSync(repoPath: string): Promise<{ ok: boolean; output: string }> {
  try {
    // Pull first, then add+commit any local changes, then push
    const pull = spawn(["git", "pull", "--rebase"], { stdout: "pipe", stderr: "pipe", cwd: repoPath });
    const pullOut = (await new Response(pull.stdout).text()).trim();
    const pullErr = (await new Response(pull.stderr).text()).trim();
    await pull.exited;

    // Check for local changes
    const status = spawn(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "pipe", cwd: repoPath });
    const changes = (await new Response(status.stdout).text()).trim();
    await status.exited;

    let committed = false;
    if (changes) {
      const add = spawn(["git", "add", "-A"], { stdout: "pipe", stderr: "pipe", cwd: repoPath });
      await add.exited;

      const commit = spawn(["git", "commit", "-m", `Sync ${new Date().toISOString().split("T")[0]}`], {
        stdout: "pipe", stderr: "pipe", cwd: repoPath,
      });
      await commit.exited;
      committed = true;
    }

    const push = spawn(["git", "push"], { stdout: "pipe", stderr: "pipe", cwd: repoPath });
    const pushOut = (await new Response(push.stdout).text()).trim();
    const pushErr = (await new Response(push.stderr).text()).trim();
    const pushCode = await push.exited;

    const parts: string[] = [];
    if (pullOut && pullOut !== "Already up to date.") parts.push(`Pull: ${pullOut}`);
    if (committed) parts.push(`Committed local changes`);
    if (pushCode === 0) parts.push("Push: OK");
    else parts.push(`Push: ${pushErr}`);

    if (!parts.length) parts.push("Already up to date.");

    return { ok: pushCode === 0, output: parts.join("\n") };
  } catch (error: any) {
    return { ok: false, output: error.message };
  }
}

bot.command("sync", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";
  await ctx.replyWithChatAction("typing");

  // Default to obsidian vault, but allow syncing any ~/dev repo
  let repoPath = OBSIDIAN_VAULT;
  let repoName = "obsidian";

  if (arg && arg !== "obsidian") {
    const devRoot = join(process.env.HOME || "~", "dev");
    repoPath = join(devRoot, arg);
    repoName = arg;
    const rel = relative(devRoot, repoPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      await ctx.reply("Path must stay within ~/dev");
      return;
    }
  }

  try {
    await stat(join(repoPath, ".git"));
  } catch {
    await ctx.reply(`${repoName} is not a git repo.`);
    return;
  }

  const { ok, output } = await gitSync(repoPath);
  await ctx.reply(`${ok ? "✅" : "❌"} Sync ${repoName}:\n${output}`);
});

// ============================================================
// LINKS
// ============================================================

async function getTailscaleIP(): Promise<string | null> {
  try {
    const proc = spawn(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
    const ip = (await new Response(proc.stdout).text()).trim();
    return ip || null;
  } catch { return null; }
}

async function getLocalIP(): Promise<string> {
  try {
    const proc = spawn(["hostname", "-I"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    return out.split(" ")[0] || "raspberrypi";
  } catch { return "raspberrypi"; }
}

bot.command("links", async (ctx) => {
  const [tailscaleIP, localIP] = await Promise.all([getTailscaleIP(), getLocalIP()]);

  const lines: string[] = ["*Pi Access Links*\n"];

  if (tailscaleIP) {
    lines.push(
      `*Via Tailscale (anywhere):*`,
      `  Filebrowser: http://${tailscaleIP}:8080`,
      `  Syncthing: http://${tailscaleIP}:8384`,
      `  Samba: smb://${tailscaleIP}/storage`,
      `  Obsidian: smb://${tailscaleIP}/obsidian`,
      ``
    );
  }

  lines.push(
    `*Via LAN (home network):*`,
    `  Filebrowser: http://${localIP}:8080`,
    `  Syncthing: http://${localIP}:8384`,
    `  Samba: smb://${localIP}/storage`,
    `  Obsidian: smb://${localIP}/obsidian`,
  );

  if (!tailscaleIP) {
    lines.push(`\n⚠️ Tailscale not connected — LAN only.`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ============================================================
// SERVICE MANAGEMENT
// ============================================================

const MANAGED_SERVICES: Record<string, string> = {
  samba: "smbd",
  filebrowser: "filebrowser",
  syncthing: "syncthing@gaetano",
};

async function runSystemctl(action: string, unit: string): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = spawn(["sudo", "systemctl", action, unit], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, output: stdout || stderr || `${action} completed` };
  } catch (error: any) {
    return { ok: false, output: error.message };
  }
}

// /service — start, stop, restart services
bot.command("service", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";

  // /service (no args) — show status of all services
  if (!arg) {
    const lines: string[] = ["*Services*\n"];
    for (const [name, unit] of Object.entries(MANAGED_SERVICES)) {
      const proc = spawn(["systemctl", "is-active", unit], { stdout: "pipe", stderr: "pipe" });
      const status = (await new Response(proc.stdout).text()).trim();
      const icon = status === "active" ? "🟢" : "🔴";
      lines.push(`${icon} ${name} (${unit}): ${status}`);
    }
    lines.push(
      `\n*Usage:*`,
      `/service start <name>`,
      `/service stop <name>`,
      `/service restart <name>`,
      `\nNames: ${Object.keys(MANAGED_SERVICES).join(", ")}`,
      `Use "all" to target every service.`
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  // Parse action and target
  const parts = arg.split(/\s+/);
  const action = parts[0]?.toLowerCase();
  const target = parts[1]?.toLowerCase();

  if (!["start", "stop", "restart"].includes(action)) {
    await ctx.reply(`Unknown action: ${action}\nUse: start, stop, or restart`);
    return;
  }

  if (!target) {
    await ctx.reply(`Usage: /service ${action} <name>\nNames: ${Object.keys(MANAGED_SERVICES).join(", ")}, all`);
    return;
  }

  await ctx.replyWithChatAction("typing");

  // Target "all" or a specific service
  const targets = target === "all"
    ? Object.entries(MANAGED_SERVICES)
    : MANAGED_SERVICES[target]
      ? [[target, MANAGED_SERVICES[target]] as [string, string]]
      : [];

  if (!targets.length) {
    await ctx.reply(`Unknown service: ${target}\nAvailable: ${Object.keys(MANAGED_SERVICES).join(", ")}, all`);
    return;
  }

  const results: string[] = [];
  for (const [name, unit] of targets) {
    const { ok, output } = await runSystemctl(action, unit);
    results.push(`${ok ? "✅" : "❌"} ${name}: ${ok ? `${action} OK` : output}`);
  }

  await ctx.reply(results.join("\n"));
});

// /help — show all capabilities
bot.command("help", async (ctx) => {
  const voiceStatus = process.env.VOICE_PROVIDER ? "enabled" : "not configured";
  const googleStatus = process.env.GOOGLE_CLIENT_ID ? "connected" : "not connected";

  await ctx.reply(
    `*What I Can Do*\n\n` +
    `*💬 Chat & AI*\n` +
    `Talk naturally — I understand context, remember things, and use tools automatically.\n` +
    `Voice messages: ${voiceStatus}\n` +
    `Send photos/documents for analysis.\n\n` +
    `*📁 File Manager (NAS)*\n` +
    `/files — browse ~/storage\n` +
    `/files <path> — list or read files\n` +
    `/files search <query> — find files by name\n` +
    `Send any file → saved to ~/storage\n` +
    `Also accessible via:\n` +
    `  SMB: smb://raspberrypi/storage\n` +
    `  Web: http://raspberrypi:8080\n\n` +
    `*📝 Obsidian Notes*\n` +
    `/note <title> — create a new note\n` +
    `/notes — list recent notes\n` +
    `/notes search <query> — search vault\n` +
    `"Add a note about..." — natural language\n` +
    `Vault synced via Syncthing.\n\n` +
    `*💻 Code Sessions*\n` +
    `/code — list ~/dev projects\n` +
    `/code <project> — code via Telegram\n` +
    `/code remote <project> — connect via claude.ai/code\n` +
    `/code stop — end session\n\n` +
    `*🔧 Tools*\n` +
    `/email — unread Gmail (${googleStatus})\n` +
    `/calendar — today's events (${googleStatus})\n` +
    `/search <query> — web search\n` +
    `/dev — browse ~/dev projects\n\n` +
    `*🖥️ Services*\n` +
    `/service — show service status\n` +
    `/service start|stop|restart <name> — control a service\n` +
    `Names: samba, filebrowser, syncthing, all\n\n` +
    `*⚙️ Session*\n` +
    `/status — full system status\n` +
    `/clear — clear chat history\n` +
    `/reset — full reset\n\n` +
    `*Services running on this Pi:*\n` +
    `  Filebrowser: http://raspberrypi:8080\n` +
    `  Syncthing: http://raspberrypi:8384\n` +
    `  Samba shares: storage, obsidian, dev`,
    { parse_mode: "Markdown" }
  );
});

// /status — show what's going on
bot.command("status", async (ctx) => {
  const history = await loadHistory();
  const googleToken = await getAccessToken();

  // Check system services
  const checkService = async (name: string): Promise<string> => {
    try {
      const proc = spawn(["systemctl", "is-active", name], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      return out === "active" ? "running" : "stopped";
    } catch { return "unknown"; }
  };

  const [smbStatus, fbStatus, syncStatus] = await Promise.all([
    checkService("smbd"),
    checkService("filebrowser"),
    checkService("syncthing@gaetano"),
  ]);

  const lines: string[] = [`*System Status*\n`];

  // Services
  lines.push(`*Services:*`);
  lines.push(`  Samba (SMB): ${smbStatus}`);
  lines.push(`  Filebrowser: ${fbStatus}`);
  lines.push(`  Syncthing: ${syncStatus}`);

  // Active session
  lines.push(``);
  if (activeCodeSession) {
    lines.push(`*Code session:* ${activeCodeSession.project} (${activeCodeSession.mode} mode)`);
    lines.push(`  Path: ${activeCodeSession.projectPath}`);
    if (activeCodeSession.mode === "remote") {
      lines.push(`  Connect: claude.ai/code`);
    } else if (activeCodeSession.sessionId) {
      lines.push(`  Session ID: ${activeCodeSession.sessionId}`);
    }
  } else {
    lines.push(`*Code session:* none`);
  }

  // Chat history
  lines.push(`\n*Chat history:* ${history.length} messages`);

  // Connections
  lines.push(`\n*Integrations:*`);
  lines.push(`  Gmail: ${googleToken ? "connected" : "not connected"}`);
  lines.push(`  Calendar: ${googleToken ? "connected" : "not connected"}`);
  lines.push(`  Supabase: ${supabase ? "connected" : "not connected"}`);
  lines.push(`  Voice: ${process.env.VOICE_PROVIDER || "not configured"}`);
  lines.push(`  MCP tools: relay-tools (6 tools)`);

  // Storage
  lines.push(`\n*Storage:*`);
  lines.push(`  NAS: ${STORAGE_DIR}`);
  lines.push(`  Obsidian vault: ${OBSIDIAN_VAULT}`);

  // Session
  lines.push(`\n*Claude session:* ${session.sessionId ? "active" : "none"}`);
  if (session.lastActivity) {
    lines.push(`  Last activity: ${new Date(session.lastActivity).toLocaleString("en-US", { timeZone: USER_TIMEZONE })}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// /clear — flush chat history
bot.command("clear", async (ctx) => {
  await clearHistory();
  activeCodeSession = null;
  await ctx.reply("Chat history cleared. Starting fresh.");
});

// /reset — full nuke: chat history + Claude session files + code session
bot.command("reset", async (ctx) => {
  await ctx.replyWithChatAction("typing");

  const deleted: string[] = [];

  // 1. Kill active code session
  if (activeCodeSession) {
    killCodeProcess();
    deleted.push(`Code session: ${activeCodeSession.project}`);
    activeCodeSession = null;
  }

  // 2. Clear local chat history + relay session
  await clearHistory();
  deleted.push("Chat history");

  // 3. Delete Claude CLI session files for this project
  const claudeProjectDir = join(
    process.env.HOME || "~",
    ".claude",
    "projects",
    (PROJECT_DIR || PROJECT_ROOT).replace(/\//g, "-").replace(/^-/, "")
  );
  try {
    const sessionFiles = await readdir(claudeProjectDir);
    for (const file of sessionFiles) {
      if (file.endsWith(".jsonl")) {
        await unlink(join(claudeProjectDir, file));
      }
    }
    deleted.push(`Claude sessions (${sessionFiles.filter(f => f.endsWith(".jsonl")).length} files)`);
  } catch {
    // No session dir or already empty
  }

  // 4. Clear Telegram chat history (delete recent bot messages)
  // Telegram Bot API doesn't support bulk delete, but we can note it
  const summary = deleted.length
    ? `Reset complete:\n${deleted.map(d => `  - ${d}`).join("\n")}\n\nClean slate.`
    : "Nothing to reset.";

  await ctx.reply(summary);
});

// /code — start a Claude Code session in a ~/dev project
// /code <project>         → prompt mode (send messages via Telegram)
// /code remote <project>  → starts `claude remote-control`, connect from claude.ai/code
// /code stop              → end active session
bot.command("code", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";
  const devRoot = join(process.env.HOME || "~", "dev");

  // /code stop — end active session and kill any running process
  if (arg === "stop") {
    if (!activeCodeSession) {
      await ctx.reply("No active code session.");
      return;
    }
    const name = activeCodeSession.project;
    const mode = activeCodeSession.mode;
    killCodeProcess();
    // Kill remote-control process if running
    if (activeCodeSession.remoteProcess) {
      try { activeCodeSession.remoteProcess.kill(); } catch {}
    }
    activeCodeSession = null;
    await ctx.reply(`${mode === "remote" ? "Remote control" : "Code"} session ended for ${name}. Back to normal mode.`);
    return;
  }

  // /code (no args) — list projects or show active session
  if (!arg) {
    if (activeCodeSession) {
      const sid = activeCodeSession.sessionId;
      let msg =
        `Active session: ${activeCodeSession.project} (${activeCodeSession.mode} mode)\n` +
        `Path: ${activeCodeSession.projectPath}\n`;
      if (activeCodeSession.mode === "remote") {
        msg += `\nConnect at: claude.ai/code\n`;
      } else if (sid) {
        msg += `Session ID: ${sid}\n\n` +
          `Connect from terminal:\n` +
          `  cd ${activeCodeSession.projectPath}\n` +
          `  claude --resume ${sid}\n\n`;
      }
      msg += activeCodeSession.mode === "prompt"
        ? `Send messages here to work on this project.\n`
        : `Use claude.ai/code to interact.\n`;
      msg += `/code stop to end the session.`;
      await ctx.reply(msg);
      return;
    }

    try {
      const entries = await readdir(devRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((d) => d.name);
      if (!dirs.length) {
        await ctx.reply("No projects found in ~/dev");
        return;
      }
      const list = dirs.map((d) => `  ${d}`).join("\n");
      await ctx.reply(
        `Projects in ~/dev:\n\n${list}\n\n` +
        `Usage:\n` +
        `  /code <project> — chat via Telegram\n` +
        `  /code remote <project> — connect via claude.ai/code\n` +
        `  /code stop — end session`
      );
    } catch {
      await ctx.reply("Could not read ~/dev");
    }
    return;
  }

  // Parse mode and project name
  const isRemote = arg.startsWith("remote ");
  const projectName = isRemote ? arg.replace("remote ", "").trim() : arg;

  // Validate project path
  const projectPath = join(devRoot, projectName);
  const rel = relative(devRoot, projectPath);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    await ctx.reply("Path must stay within ~/dev");
    return;
  }

  try {
    const info = await stat(projectPath);
    if (!info.isDirectory()) {
      await ctx.reply(`${projectName} is not a directory.`);
      return;
    }
  } catch {
    await ctx.reply(`Project not found: ~/dev/${projectName}`);
    return;
  }

  // Stop existing session if any
  if (activeCodeSession) {
    killCodeProcess();
    if (activeCodeSession.remoteProcess) {
      try { activeCodeSession.remoteProcess.kill(); } catch {}
    }
  }

  if (isRemote) {
    // Start claude remote-control as a background process
    const remoteProc = spawn(
      [CLAUDE_PATH, "remote-control", "--name", projectName, "--permission-mode", "bypassPermissions"],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: projectPath,
        env: { ...process.env },
      }
    );

    activeCodeSession = {
      project: projectName,
      projectPath,
      sessionId: null,
      mode: "remote",
      remoteProcess: remoteProc,
    };

    // Read initial output to capture the connection URL/info
    let startupOutput = "";
    const reader = remoteProc.stdout.getReader();
    const startTime = Date.now();

    // Read for up to 10 seconds to capture startup messages
    while (Date.now() - startTime < 10_000) {
      const readPromise = reader.read();
      const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 10_000 - (Date.now() - startTime))
      );
      const { done, value } = await Promise.race([readPromise, timeout]);
      if (done || !value) break;
      startupOutput += new TextDecoder().decode(value);
      // Stop reading once we have some output
      if (startupOutput.includes("claude.ai") || startupOutput.length > 200) break;
    }
    reader.releaseLock();

    // Monitor the process — notify if it dies
    remoteProc.exited.then((code) => {
      if (activeCodeSession?.mode === "remote" && activeCodeSession?.project === projectName) {
        activeCodeSession = null;
        console.log(`[remote-control] Process exited with code ${code}`);
      }
    });

    await ctx.reply(
      `Remote control started: ${projectName}\n` +
      `Working directory: ${projectPath}\n\n` +
      `Open claude.ai/code to connect.\n\n` +
      (startupOutput.trim() ? `Output:\n${startupOutput.trim()}\n\n` : "") +
      `/code stop to end the session.`
    );
  } else {
    // Prompt mode — send messages via Telegram
    activeCodeSession = {
      project: projectName,
      projectPath,
      sessionId: null,
      mode: "prompt",
    };

    await ctx.reply(
      `Code session started: ${projectName}\n` +
      `Working directory: ${projectPath}\n\n` +
      `Send instructions like:\n` +
      `  "read the README"\n` +
      `  "fix the login bug in src/auth.ts"\n` +
      `  "run the tests"\n\n` +
      `Switch to remote: /code stop then /code remote ${projectName}\n` +
      `/code stop to end the session.`
    );
  }
});

// /search — web search
bot.command("search", async (ctx) => {
  const query = ctx.match?.toString().trim();
  if (!query) {
    await ctx.reply("Usage: /search <query>\nExample: /search latest bun release");
    return;
  }

  await ctx.replyWithChatAction("typing");
  console.log(`Search: ${query}`);

  try {
    const searchResults = await webSearch(query);
    if (!searchResults) {
      await ctx.reply("No search results found.");
      return;
    }

    await appendHistory("user", `[Search]: ${query}`);
    await saveMessage("user", `[Search]: ${query}`);

    const history = await loadHistory();
    const enrichedPrompt = buildPrompt(
      `The user searched for: "${query}"\n\nHere are the web search results:\n${searchResults}\n\nSummarize the key findings concisely.`,
      undefined,
      undefined,
      history
    );
    const rawResponse = await callClaude(enrichedPrompt);
    const response = await processMemoryIntents(supabase, rawResponse);

    await appendHistory("assistant", response);
    await saveMessage("assistant", response);
    await sendResponse(ctx, response);
  } catch (error) {
    console.error("Search error:", error);
    await ctx.reply("Search failed. Try again later.");
  }
});

// /dev — browse ~/dev projects (read-only)
bot.command("dev", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";
  const devRoot = join(process.env.HOME || "~", "dev");

  try {
    if (!arg) {
      // List all folders in ~/dev
      const entries = await readdir(devRoot, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
      if (!dirs.length) {
        await ctx.reply("No projects found in ~/dev");
        return;
      }
      const list = dirs.map((d) => `  ${d.name}/`).join("\n");
      await ctx.reply(`Projects in ~/dev:\n\n${list}\n\nUse /dev <project> to browse.`);
      return;
    }

    // Resolve path and ensure it stays within ~/dev
    const targetPath = join(devRoot, arg);
    const rel = relative(devRoot, targetPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      await ctx.reply("Path must stay within ~/dev");
      return;
    }

    const info = await stat(targetPath);

    if (info.isDirectory()) {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 50)
        .map((e) => `  ${e.isDirectory() ? e.name + "/" : e.name}`);
      const header = `~/dev/${rel}/`;
      await ctx.reply(`${header}\n\n${lines.join("\n")}${entries.length > 50 ? "\n  ... (truncated)" : ""}`);
    } else if (info.isFile()) {
      // Read file (max 3000 chars to fit in Telegram)
      const content = await readFile(targetPath, "utf-8");
      const preview = content.length > 3000 ? content.substring(0, 3000) + "\n... (truncated)" : content;
      await ctx.reply(`~/dev/${rel}:\n\n${preview}`);
    }
  } catch (error: any) {
    if (error.code === "ENOENT") {
      await ctx.reply(`Not found: ~/dev/${arg}`);
    } else {
      console.error("Dev browse error:", error);
      await ctx.reply("Could not browse that path.");
    }
  }
});

// ============================================================
// FILE MANAGER (NAS)
// ============================================================

// /files — browse, search, download from ~/storage
bot.command("files", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";

  try {
    // /files search <query> — find files by name
    if (arg.startsWith("search ")) {
      const query = arg.replace("search ", "").trim().toLowerCase();
      if (!query) {
        await ctx.reply("Usage: /files search <query>");
        return;
      }

      await ctx.replyWithChatAction("typing");
      const results: string[] = [];

      async function searchDir(dir: string, prefix: string) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const fullPath = join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.name.toLowerCase().includes(query)) {
            results.push(entry.isDirectory() ? `📁 ${relPath}/` : `📄 ${relPath}`);
          }
          if (entry.isDirectory() && results.length < 50) {
            await searchDir(fullPath, relPath);
          }
        }
      }

      await searchDir(STORAGE_DIR, "");
      if (!results.length) {
        await ctx.reply(`No files matching "${query}" in storage.`);
        return;
      }
      await ctx.reply(`Found ${results.length} match(es):\n\n${results.slice(0, 30).join("\n")}${results.length > 30 ? "\n... (truncated)" : ""}`);
      return;
    }

    // /files download <path> — send file back via Telegram
    if (arg.startsWith("download ")) {
      const filePath = join(STORAGE_DIR, arg.replace("download ", "").trim());
      const rel = relative(STORAGE_DIR, filePath);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        await ctx.reply("Path must stay within storage.");
        return;
      }
      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          await ctx.reply("That's a directory, not a file.");
          return;
        }
        if (info.size > 50 * 1024 * 1024) {
          await ctx.reply("File too large for Telegram (>50MB). Use Filebrowser or SMB instead.");
          return;
        }
        const fileBuffer = await readFile(filePath);
        await ctx.replyWithDocument(new InputFile(fileBuffer, rel.split("/").pop() || "file"));
      } catch {
        await ctx.reply(`File not found: ${rel}`);
      }
      return;
    }

    // /files (no args) — list root of storage
    if (!arg) {
      const entries = await readdir(STORAGE_DIR, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 50)
        .map((e) => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);
      if (!items.length) {
        await ctx.reply("Storage is empty. Send a file to upload it, or use /files <path> to browse.");
        return;
      }
      await ctx.reply(
        `*Storage*\n\n${items.join("\n")}\n\n` +
        `/files <path> — browse deeper\n` +
        `/files download <path> — get a file\n` +
        `/files search <query> — find files`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // /files <path> — browse a subdirectory or read a file
    const targetPath = join(STORAGE_DIR, arg);
    const rel = relative(STORAGE_DIR, targetPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      await ctx.reply("Path must stay within storage.");
      return;
    }

    const info = await stat(targetPath);
    if (info.isDirectory()) {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 50)
        .map((e) => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);
      await ctx.reply(`storage/${rel}/\n\n${items.join("\n") || "(empty)"}`);
    } else {
      // Small text files: show content. Others: offer download
      if (info.size < 10000 && !isBinaryFile(rel)) {
        const content = await readFile(targetPath, "utf-8");
        await ctx.reply(`storage/${rel}:\n\n${content.substring(0, 3000)}`);
      } else {
        const sizeStr = info.size > 1024 * 1024
          ? `${(info.size / 1024 / 1024).toFixed(1)}MB`
          : `${(info.size / 1024).toFixed(1)}KB`;
        await ctx.reply(`storage/${rel} (${sizeStr})\n\nUse /files download ${rel} to get it.`);
      }
    }
  } catch (error: any) {
    if (error.code === "ENOENT") {
      await ctx.reply(`Not found: ${arg}`);
    } else {
      console.error("Files error:", error);
      await ctx.reply("Could not browse files.");
    }
  }
});

function isBinaryFile(name: string): boolean {
  const textExts = [".txt", ".md", ".json", ".ts", ".js", ".csv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log", ".sh", ".py", ".html", ".css"];
  return !textExts.some((ext) => name.toLowerCase().endsWith(ext));
}

// ============================================================
// OBSIDIAN NOTES
// ============================================================

// /note <title> — create a note (optionally with content after a newline)
bot.command("note", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";
  if (!arg) {
    await ctx.reply("Usage: /note <title>\nExample: /note Meeting notes for March 10");
    return;
  }

  await ctx.replyWithChatAction("typing");

  // Parse title (first line) and optional body
  const lines = arg.split("\n");
  const title = lines[0].trim();
  const body = lines.slice(1).join("\n").trim();

  // Sanitize filename
  const fileName = title.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ") + ".md";
  const filePath = join(OBSIDIAN_VAULT, fileName);

  // Check if note already exists
  try {
    await stat(filePath);
    await ctx.reply(`Note "${title}" already exists. Use natural language to ask me to update it.`);
    return;
  } catch {
    // Good — doesn't exist yet
  }

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const frontmatter = `---\ntitle: "${title}"\ndate: ${dateStr}\ntags: []\n---\n\n`;

  let content = frontmatter;
  if (body) {
    content += body + "\n";
  } else {
    // Ask Claude to generate initial content based on the title
    const history = await loadHistory();
    const prompt = buildPrompt(
      `Create a brief Obsidian note with title "${title}". ` +
      `Write just the note content (no frontmatter, I'll add that). ` +
      `Use Obsidian-style markdown: wikilinks [[like this]], #tags, bullet points. ` +
      `Keep it concise — a starting point the user can expand.`,
      undefined,
      undefined,
      history
    );
    const generated = await callClaude(prompt);
    content += generated + "\n";
  }

  await writeFile(filePath, content);

  await appendHistory("user", `[Created note]: ${title}`);
  await saveMessage("user", `[Created note]: ${title}`);

  // Auto-push to GitHub
  const { ok } = await gitSync(OBSIDIAN_VAULT);
  await ctx.reply(`Note created: ${fileName}${ok ? " (synced to GitHub)" : ""}\n\nEdit it in Obsidian, via Filebrowser, or ask me to update it.`);
});

// /notes — list or search notes in the vault
bot.command("notes", async (ctx) => {
  const arg = ctx.match?.toString().trim() || "";

  try {
    // /notes search <query> — search note titles and content
    if (arg.startsWith("search ")) {
      const query = arg.replace("search ", "").trim().toLowerCase();
      if (!query) {
        await ctx.reply("Usage: /notes search <query>");
        return;
      }

      await ctx.replyWithChatAction("typing");
      const matches: { file: string; line: string }[] = [];

      async function searchVault(dir: string, prefix: string) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const fullPath = join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            await searchVault(fullPath, relPath);
            continue;
          }

          if (!entry.name.endsWith(".md")) continue;

          // Check filename match
          if (entry.name.toLowerCase().includes(query)) {
            matches.push({ file: relPath, line: "(title match)" });
            continue;
          }

          // Check content
          try {
            const content = await readFile(fullPath, "utf-8");
            const lines = content.split("\n");
            for (const line of lines) {
              if (line.toLowerCase().includes(query)) {
                matches.push({ file: relPath, line: line.trim().substring(0, 80) });
                break;
              }
            }
          } catch {}
        }
      }

      await searchVault(OBSIDIAN_VAULT, "");
      if (!matches.length) {
        await ctx.reply(`No notes matching "${query}".`);
        return;
      }
      const formatted = matches
        .slice(0, 20)
        .map((m) => `📝 ${m.file}\n   ${m.line}`)
        .join("\n\n");
      await ctx.reply(`Found ${matches.length} note(s):\n\n${formatted}`);
      return;
    }

    // /notes read <path> — read a note
    if (arg.startsWith("read ")) {
      const notePath = arg.replace("read ", "").trim();
      const fullPath = join(OBSIDIAN_VAULT, notePath);
      const rel = relative(OBSIDIAN_VAULT, fullPath);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        await ctx.reply("Path must stay within the vault.");
        return;
      }

      // Try with and without .md extension
      let targetPath = fullPath;
      try {
        await stat(targetPath);
      } catch {
        targetPath = fullPath + ".md";
        try {
          await stat(targetPath);
        } catch {
          await ctx.reply(`Note not found: ${notePath}`);
          return;
        }
      }

      const content = await readFile(targetPath, "utf-8");
      const preview = content.length > 3000 ? content.substring(0, 3000) + "\n... (truncated)" : content;
      await ctx.reply(`📝 ${rel}\n\n${preview}`);
      return;
    }

    // /notes (no args) — list recent notes
    const allNotes: { name: string; mtime: Date }[] = [];

    async function collectNotes(dir: string, prefix: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await collectNotes(fullPath, relPath);
        } else if (entry.name.endsWith(".md")) {
          const info = await stat(fullPath);
          allNotes.push({ name: relPath, mtime: info.mtime });
        }
      }
    }

    await collectNotes(OBSIDIAN_VAULT, "");

    if (!allNotes.length) {
      await ctx.reply("No notes in vault yet.\n\nCreate one: /note <title>");
      return;
    }

    // Sort by most recent
    allNotes.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const list = allNotes
      .slice(0, 20)
      .map((n) => `📝 ${n.name}`)
      .join("\n");

    await ctx.reply(
      `*Obsidian Vault* (${allNotes.length} notes)\n\n${list}\n\n` +
      `/notes search <query> — search content\n` +
      `/notes read <name> — read a note\n` +
      `/note <title> — create new`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Notes error:", error);
    await ctx.reply("Could not read vault.");
  }
});

// ============================================================
// TOOLS: EMAIL, CALENDAR, SEARCH
// ============================================================

// /email — check inbox (read-only)
bot.command("email", async (ctx) => {
  await ctx.replyWithChatAction("typing");

  const token = await getAccessToken();
  if (!token) {
    await ctx.reply("Gmail not connected. Run: bun run setup:google");
    return;
  }

  try {
    const emails = await getUnreadEmails(10);
    const summary = formatEmails(emails);

    // Ask Claude to highlight what's important
    const history = await loadHistory();
    const prompt = buildPrompt(
      `Here are my unread emails:\n\n${summary}\n\nTell me briefly if anything looks important or needs attention.`,
      undefined,
      undefined,
      history
    );
    const rawResponse = await callClaude(prompt);
    const response = await processMemoryIntents(supabase, rawResponse);

    await appendHistory("user", "[Checked email]");
    await appendHistory("assistant", response);
    await saveMessage("assistant", response);
    await sendResponse(ctx, response);
  } catch (error) {
    console.error("Email command error:", error);
    await ctx.reply("Could not fetch emails.");
  }
});

// /calendar — check today's events (read-only)
bot.command("calendar", async (ctx) => {
  await ctx.replyWithChatAction("typing");

  const token = await getAccessToken();
  if (!token) {
    await ctx.reply("Calendar not connected. Run: bun run setup:google");
    return;
  }

  try {
    const events = await getTodayEvents();
    const summary = formatEvents(events);

    const history = await loadHistory();
    const prompt = buildPrompt(
      `Here is my calendar for today:\n\n${summary}\n\nGive me a brief overview. Flag anything I should prepare for.`,
      undefined,
      undefined,
      history
    );
    const rawResponse = await callClaude(prompt);
    const response = await processMemoryIntents(supabase, rawResponse);

    await appendHistory("user", "[Checked calendar]");
    await appendHistory("assistant", response);
    await saveMessage("assistant", response);
    await sendResponse(ctx, response);
  } catch (error) {
    console.error("Calendar command error:", error);
    await ctx.reply("Could not fetch calendar.");
  }
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await appendHistory("user", text);
  await saveMessage("user", text);

  // If a code session is active, route to the isolated code process
  if (activeCodeSession) {
    console.log(`[code-session] Routing to ${activeCodeSession.project}`);

    // Keep typing indicator alive during long operations
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      const hadSession = !!activeCodeSession.sessionId;
      const result = await callClaudeCode(
        text,
        activeCodeSession.projectPath,
        activeCodeSession.sessionId
      );
      activeCodeSession.sessionId = result.sessionId;
      clearInterval(typingInterval);

      await appendHistory("assistant", result.output);
      await saveMessage("assistant", result.output);
      await sendResponse(ctx, result.output);

      // Show session ID on first response so user can connect from Claude app
      if (!hadSession && result.sessionId) {
        await ctx.reply(
          `Session ID: ${result.sessionId}\n` +
          `Connect from Claude app:\n` +
          `  cd ${activeCodeSession.projectPath} && claude --resume ${result.sessionId}`
        );
      }
    } catch (error: any) {
      clearInterval(typingInterval);
      await ctx.reply(`Code session error: ${error.message}\n/code stop to end session.`);
    }
    return;
  }

  // Gather context: semantic search + facts/goals + chat history
  const [relevantContext, memoryContext, history] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
    loadHistory(),
  ]);

  // Claude has MCP tools (email, calendar, search, dev, weather)
  // — it decides when to use them, no regex detection needed
  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, history);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await appendHistory("assistant", response);
  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    const voiceText = `[Voice ${voice.duration}s]: ${transcription}`;
    await appendHistory("user", voiceText);
    await saveMessage("user", voiceText);

    const [relevantContext, memoryContext, history] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
      loadHistory(),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext,
      history
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await appendHistory("assistant", claudeResponse);
    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents — save to storage + analyze
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const fileName = doc.file_name || `file_${Date.now()}`;

    // Save to storage permanently
    await mkdir(STORAGE_DIR, { recursive: true });
    const storagePath = join(STORAGE_DIR, fileName);
    // Avoid overwriting — add timestamp if file exists
    let finalPath = storagePath;
    try {
      await stat(storagePath);
      const ext = fileName.includes(".") ? "." + fileName.split(".").pop() : "";
      const base = ext ? fileName.slice(0, -ext.length) : fileName;
      finalPath = join(STORAGE_DIR, `${base}_${Date.now()}${ext}`);
    } catch {
      // Doesn't exist, use original name
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(finalPath, Buffer.from(buffer));

    const savedName = relative(STORAGE_DIR, finalPath);
    const caption = ctx.message.caption || "";

    await saveMessage("user", `[Document: ${savedName}]: ${caption || "uploaded"}`);

    // If there's a caption, analyze the file with Claude
    if (caption) {
      const prompt = `[File: ${finalPath}]\n\n${caption}`;
      const claudeResponse = await callClaude(prompt, { resume: true });
      const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
      await saveMessage("assistant", cleanResponse);
      await sendResponse(ctx, `Saved to storage/${savedName}\n\n${cleanResponse}`);
    } else {
      await ctx.reply(
        `Saved: storage/${savedName}\n\n` +
        `Access via:\n` +
        `  /files download ${savedName}\n` +
        `  SMB: smb://raspberrypi/storage/${savedName}\n` +
        `  Web: http://raspberrypi:8080`
      );
    }
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// WEB SEARCH
// ============================================================

async function webSearch(query: string): Promise<string> {
  try {
    // Use DuckDuckGo lite HTML search
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)" },
    });
    const html = await res.text();

    // Extract text snippets from result rows
    const results: string[] = [];
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const linkRegex = /<a[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    const links: string[] = [];
    while ((match = linkRegex.exec(html)) !== null) {
      links.push(match[1].replace(/<[^>]+>/g, "").trim());
    }

    let i = 0;
    while ((match = snippetRegex.exec(html)) !== null) {
      const snippet = match[1].replace(/<[^>]+>/g, "").trim();
      if (snippet) {
        const link = links[i] || "";
        results.push(`${link}\n${snippet}`);
      }
      i++;
    }

    if (!results.length) {
      // Fallback: extract any readable text between <td> tags in result areas
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((match = tdRegex.exec(html)) !== null && results.length < 8) {
        const text = match[1].replace(/<[^>]+>/g, "").trim();
        if (text.length > 40) results.push(text);
      }
    }

    return results.slice(0, 6).join("\n\n") || "No results found.";
  } catch (error) {
    console.error("Web search error:", error);
    return "Search unavailable.";
  }
}

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  history?: ChatMessage[]
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  // Include recent chat history for conversational context
  if (history?.length) {
    // Exclude the current message (last entry) since it's the userMessage
    const previous = history.slice(0, -1).slice(-10);
    if (previous.length) {
      parts.push(
        "\nRECENT CONVERSATION:\n" +
          previous.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n")
      );
    }
  }

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
