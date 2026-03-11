/**
 * Local MCP Server — Tools for Claude
 *
 * Exposes read-only tools that Claude can call naturally:
 * - check_email: Fetch unread Gmail
 * - check_calendar: Fetch today's events
 * - web_search: Search the internet
 * - browse_dev: Browse ~/dev projects
 *
 * Claude decides when to use these — no regex/intent detection needed.
 *
 * Runs as a stdio MCP server. Register with:
 *   claude mcp add relay-tools -- bun run /path/to/mcp-server.ts
 */

import { getAccessToken } from "./google-auth.ts";
import { getUnreadEmails, formatEmails } from "./gmail.ts";
import { getTodayEvents, formatEvents, createEvent } from "./calendar.ts";
import { generateDailyNote } from "./daily-note.ts";
import { updateWeeklyNote } from "./weekly-note.ts";
import { readFile, readdir, stat, writeFile, mkdir } from "fs/promises";
import { join, relative } from "path";
import { spawn } from "bun";

const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(process.env.HOME || "~", "dev", "obsidian");
const STORAGE_DIR = process.env.STORAGE_DIR || join(process.env.HOME || "~", "storage");

// ============================================================
// MCP Protocol (stdio JSON-RPC)
// ============================================================

const TOOLS = [
  {
    name: "check_email",
    description: "Check unread Gmail inbox (read-only). Returns a summary of unread emails with sender, subject, and snippet. Highlights important emails.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: {
          type: "number",
          description: "Maximum number of emails to fetch (default: 10)",
        },
      },
    },
  },
  {
    name: "check_calendar",
    description: "Check today's Google Calendar events (read-only). Returns a list of events with times, titles, and locations.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "web_search",
    description: "Search the internet using DuckDuckGo. Use this when the user asks to look something up, find information online, or needs current/recent data.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "browse_dev",
    description: "Browse projects in ~/dev directory (read-only). Can list projects, list files in a project, or read a file's contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to ~/dev. Empty or omitted to list all projects. 'project-name' to list files. 'project-name/src/file.ts' to read a file.",
        },
      },
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a new Google Calendar event with optional Google Meet link. Use this when the user wants to schedule a meeting, add an event, or book time.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Event title",
        },
        start: {
          type: "string",
          description: "Start time in ISO 8601 format, e.g. '2026-03-10T14:00:00'",
        },
        end: {
          type: "string",
          description: "End time in ISO 8601 format, e.g. '2026-03-10T15:00:00'",
        },
        description: {
          type: "string",
          description: "Event description (optional)",
        },
        location: {
          type: "string",
          description: "Event location (optional)",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses (optional)",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note in the Obsidian vault. Use when the user asks to save a note, write something down, remember something in notes, or add to their knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title (used as filename)" },
        content: { type: "string", description: "Note content in markdown. Use Obsidian wikilinks [[like this]] and #tags where appropriate." },
        folder: { type: "string", description: "Subfolder in vault (optional, e.g. 'daily', 'projects')" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "read_note",
    description: "Read a note from the Obsidian vault. Use when the user asks about their notes, wants to see a note, or references something they wrote.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Note filename or path relative to vault (with or without .md extension)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notes",
    description: "Search notes in the Obsidian vault by title or content. Use when the user asks to find notes, look up something in their vault, or references past notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to find in note titles and content" },
      },
      required: ["query"],
    },
  },
  {
    name: "edit_note",
    description: "Append content to or replace content in an existing Obsidian note. Use when the user asks to update, add to, or modify an existing note.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Note filename or path relative to vault" },
        append: { type: "string", description: "Content to append to the note" },
        replace_content: { type: "string", description: "If provided, replaces the entire note content (keeps frontmatter)" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_notes",
    description: "List notes in the Obsidian vault, optionally in a specific folder. Use when the user asks what notes they have or wants to browse their vault.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Subfolder to list (optional, empty for root)" },
      },
    },
  },
  {
    name: "get_weather",
    description: "Get current weather for a city.",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name (default: London)",
        },
      },
    },
  },
  {
    name: "add_to_daily",
    description: "Add content to today's daily note under a specific section. Use when the user wants to add a todo, journal entry, health data, or general note. Examples: 'add buy groceries to my todo', 'I walked 8000 steps today', 'had a great meeting with John'.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["todo", "journal", "health", "notes"],
          description: "Which section to add to: todo, journal, health, or notes",
        },
        content: {
          type: "string",
          description: "The content to add",
        },
      },
      required: ["section", "content"],
    },
  },
  {
    name: "get_daily",
    description: "Read today's daily note (or a specific date's). Use when the user asks about their daily note, todos, schedule, or journal.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format (optional, defaults to today)",
        },
      },
    },
  },
  {
    name: "update_weekly",
    description: "Generate or update the weekly note with aggregated data from daily notes. Use when the user asks for a weekly summary or wants to update their weekly note.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ============================================================
// Tool Implementations
// ============================================================

async function handleCheckEmail(args: any): Promise<string> {
  const token = await getAccessToken();
  if (!token) return "Gmail not connected. Run: bun run setup:google";
  const emails = await getUnreadEmails(args?.max_results || 10);
  return formatEmails(emails);
}

async function handleCheckCalendar(): Promise<string> {
  const token = await getAccessToken();
  if (!token) return "Calendar not connected. Run: bun run setup:google";
  const events = await getTodayEvents();
  return formatEvents(events);
}

async function handleWebSearch(args: any): Promise<string> {
  const query = args?.query;
  if (!query) return "No search query provided.";

  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)" },
    });
    const html = await res.text();

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
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((match = tdRegex.exec(html)) !== null && results.length < 8) {
        const text = match[1].replace(/<[^>]+>/g, "").trim();
        if (text.length > 40) results.push(text);
      }
    }

    return results.slice(0, 6).join("\n\n") || "No results found.";
  } catch {
    return "Search unavailable.";
  }
}

async function handleBrowseDev(args: any): Promise<string> {
  const devRoot = join(process.env.HOME || "~", "dev");
  const argPath = args?.path?.trim() || "";

  try {
    if (!argPath) {
      const entries = await readdir(devRoot, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
      if (!dirs.length) return "No projects found in ~/dev";
      return "Projects in ~/dev:\n" + dirs.map((d) => `  ${d.name}/`).join("\n");
    }

    const targetPath = join(devRoot, argPath);
    const rel = relative(devRoot, targetPath);
    if (rel.startsWith("..") || rel.startsWith("/")) return "Path must stay within ~/dev";

    const info = await stat(targetPath);
    if (info.isDirectory()) {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith("."))
        .slice(0, 50)
        .map((e) => `  ${e.isDirectory() ? e.name + "/" : e.name}`);
      return `~/dev/${rel}/\n${lines.join("\n")}`;
    } else if (info.isFile()) {
      const content = await readFile(targetPath, "utf-8");
      return content.length > 3000
        ? content.substring(0, 3000) + "\n... (truncated)"
        : content;
    }
    return "Not a file or directory.";
  } catch (error: any) {
    if (error.code === "ENOENT") return `Not found: ~/dev/${argPath}`;
    return "Could not browse that path.";
  }
}

async function handleGetWeather(args: any): Promise<string> {
  const city = args?.city || "London";
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
    if (!res.ok) return "Weather unavailable";
    return (await res.text()).trim();
  } catch {
    return "Weather unavailable";
  }
}

async function handleCreateCalendarEvent(args: any): Promise<string> {
  const token = await getAccessToken();
  if (!token) return "Calendar not connected. Run: bun run setup:google";

  if (!args?.summary || !args?.start || !args?.end) {
    return "Missing required fields: summary, start, end";
  }

  const result = await createEvent({
    summary: args.summary,
    start: args.start,
    end: args.end,
    description: args.description,
    location: args.location,
    attendees: args.attendees,
  });

  if (!result) return "Failed to create event.";
  return `Event created: ${args.summary}\nLink: ${result.link}`;
}

// ============================================================
// Obsidian Tools
// ============================================================

async function gitSyncVault(): Promise<string> {
  try {
    const opts = { cwd: OBSIDIAN_VAULT, stdout: "pipe" as const, stderr: "pipe" as const };

    // 1. Commit any local changes first (so pull --rebase never hits dirty worktree)
    const status = spawn(["git", "status", "--porcelain"], opts);
    const changes = (await new Response(status.stdout).text()).trim();
    await status.exited;

    if (changes) {
      const add = spawn(["git", "add", "-A"], opts);
      await add.exited;
      const dateStr = new Date().toISOString().split("T")[0];
      const commit = spawn(["git", "commit", "-m", `Auto sync ${dateStr}`], opts);
      await commit.exited;
    }

    // 2. Pull remote changes (rebase local commits on top)
    const pull = spawn(["git", "pull", "--rebase"], opts);
    const pullErr = (await new Response(pull.stderr).text()).trim();
    const pullCode = await pull.exited;
    if (pullCode !== 0) return `Git pull failed: ${pullErr}`;

    // 3. Push everything
    const push = spawn(["git", "push"], opts);
    const pushErr = (await new Response(push.stderr).text()).trim();
    const pushCode = await push.exited;

    return pushCode === 0 ? "Synced OK." : `Git push failed: ${pushErr}`;
  } catch (err: any) {
    return `Git sync error: ${err.message}`;
  }
}

async function handleCreateNote(args: any): Promise<string> {
  const title = args?.title;
  const content = args?.content || "";
  const folder = args?.folder;
  if (!title) return "Missing title.";

  const fileName = title.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ") + ".md";
  const dir = folder ? join(OBSIDIAN_VAULT, folder) : OBSIDIAN_VAULT;
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);

  try {
    await stat(filePath);
    return `Note "${title}" already exists. Use edit_note to update it.`;
  } catch {}

  const dateStr = new Date().toISOString().split("T")[0];
  const note = `---\ntitle: "${title}"\ndate: ${dateStr}\ntags: []\n---\n\n${content}\n`;
  await writeFile(filePath, note);
  const syncResult = await gitSyncVault();

  const relPath = folder ? `${folder}/${fileName}` : fileName;
  return `Note created: ${relPath} (${syncResult})`;
}

async function handleReadNote(args: any): Promise<string> {
  let notePath = args?.path || "";
  if (!notePath) return "Missing path.";

  let fullPath = join(OBSIDIAN_VAULT, notePath);
  try {
    await stat(fullPath);
  } catch {
    fullPath = fullPath + ".md";
    try { await stat(fullPath); } catch { return `Note not found: ${notePath}`; }
  }

  const content = await readFile(fullPath, "utf-8");
  return content.length > 4000 ? content.substring(0, 4000) + "\n... (truncated)" : content;
}

async function handleSearchNotes(args: any): Promise<string> {
  const query = (args?.query || "").toLowerCase();
  if (!query) return "Missing search query.";

  const matches: string[] = [];

  async function search(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await search(fullPath, relPath);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.toLowerCase().includes(query)) {
        matches.push(`${relPath} (title match)`);
        continue;
      }
      try {
        const content = await readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.toLowerCase().includes(query)) {
            matches.push(`${relPath}: ${line.trim().substring(0, 80)}`);
            break;
          }
        }
      } catch {}
    }
  }

  await search(OBSIDIAN_VAULT, "");
  if (!matches.length) return `No notes matching "${query}".`;
  return `Found ${matches.length} note(s):\n${matches.slice(0, 20).join("\n")}`;
}

async function handleEditNote(args: any): Promise<string> {
  let notePath = args?.path || "";
  if (!notePath) return "Missing path.";

  let fullPath = join(OBSIDIAN_VAULT, notePath);
  try { await stat(fullPath); } catch {
    fullPath = fullPath + ".md";
    try { await stat(fullPath); } catch { return `Note not found: ${notePath}`; }
  }

  const existing = await readFile(fullPath, "utf-8");

  if (args?.replace_content) {
    // Keep frontmatter, replace body
    const fmEnd = existing.indexOf("---", 4);
    const frontmatter = fmEnd > 0 ? existing.substring(0, fmEnd + 3) + "\n\n" : "";
    await writeFile(fullPath, frontmatter + args.replace_content + "\n");
  } else if (args?.append) {
    await writeFile(fullPath, existing.trimEnd() + "\n\n" + args.append + "\n");
  } else {
    return "Provide 'append' or 'replace_content'.";
  }

  const syncResult = await gitSyncVault();
  return `Note updated: ${notePath} (${syncResult})`;
}

async function handleListNotes(args: any): Promise<string> {
  const folder = args?.folder || "";
  const dir = folder ? join(OBSIDIAN_VAULT, folder) : OBSIDIAN_VAULT;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => e.isDirectory() ? `📁 ${e.name}/` : `📝 ${e.name}`);
    if (!items.length) return folder ? `No notes in ${folder}/` : "Vault is empty.";
    return items.join("\n");
  } catch {
    return `Folder not found: ${folder}`;
  }
}

// ============================================================
// Daily/Weekly Note Tools
// ============================================================

async function ensureDailyNote(dateStr?: string): Promise<string> {
  const date = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
  const ds = date.toISOString().split("T")[0];
  const filePath = join(OBSIDIAN_VAULT, "daily", `${ds}.md`);
  try {
    await stat(filePath);
    return filePath;
  } catch {
    return await generateDailyNote(date);
  }
}

async function handleAddToDaily(args: any): Promise<string> {
  const section = args?.section;
  const content = args?.content;
  if (!section || !content) return "Missing section or content.";

  const filePath = await ensureDailyNote();
  const existing = await readFile(filePath, "utf-8");
  const lines = existing.split("\n");
  const result: string[] = [];

  let inserted = false;
  let inTargetSection = false;
  const sectionMap: Record<string, string> = {
    todo: "to-do",
    journal: "journal",
    health: "health",
    notes: "notes",
  };
  const target = sectionMap[section];
  if (!target) return `Unknown section: ${section}. Use: todo, journal, health, notes.`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("## ")) {
      if (inTargetSection && !inserted) {
        // Insert before the next section
        if (section === "todo") {
          result.push(`- [ ] ${content}`);
        } else if (section === "notes") {
          const timestamp = new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          result.push(`- **${timestamp}** — ${content}`);
        } else {
          result.push(content);
        }
        result.push("");
        inserted = true;
      }
      inTargetSection = line.replace("## ", "").trim().toLowerCase().includes(target);
    }

    result.push(line);

    // For health section, try to update existing lines intelligently
    if (inTargetSection && section === "health" && !inserted) {
      const contentLower = content.toLowerCase();

      // Weight
      if (contentLower.includes("weight") || contentLower.match(/\d+(\.\d+)?\s*kg/)) {
        const weightMatch = content.match(/([\d.]+)\s*kg/i);
        if (weightMatch) {
          // Look ahead for the weight line and replace it
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].match(/weighed myself/i)) {
              lines[j] = `- [x] Weighed myself: ${weightMatch[1]} kg`;
              inserted = true;
              break;
            }
            if (lines[j].startsWith("## ")) break;
          }
        }
      }

      // Steps
      if (contentLower.includes("step")) {
        const stepsMatch = content.match(/([\d,]+)\s*steps?/i);
        if (stepsMatch) {
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].match(/^- Steps:/i)) {
              lines[j] = `- Steps: ${stepsMatch[1]}`;
              inserted = true;
              break;
            }
            if (lines[j].startsWith("## ")) break;
          }
        }
      }

      // Exercise
      if (contentLower.includes("exercise") || contentLower.includes("workout") || contentLower.includes("gym") || contentLower.includes("run") || contentLower.includes("walk")) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^- Exercise:/i)) {
            const existing = lines[j].replace(/^- Exercise:\s*/, "").trim();
            lines[j] = `- Exercise: ${existing ? existing + ", " : ""}${content}`;
            inserted = true;
            break;
          }
          if (lines[j].startsWith("## ")) break;
        }
      }

      // If health content matched a specific field, rebuild result from modified lines
      if (inserted) {
        const rebuilt: string[] = [];
        for (let k = 0; k < lines.length; k++) {
          rebuilt.push(lines[k]);
        }
        await writeFile(filePath, rebuilt.join("\n"));
        const syncResult = await gitSyncVault();
        return `Added to health in daily note. (${syncResult})`;
      }
    }
  }

  // If we reached end of file while still in target section
  if (inTargetSection && !inserted) {
    if (section === "todo") {
      result.push(`- [ ] ${content}`);
    } else if (section === "notes") {
      const timestamp = new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      result.push(`- **${timestamp}** — ${content}`);
    } else {
      result.push(content);
    }
    inserted = true;
  }

  if (!inserted) {
    return `Could not find section "${section}" in daily note.`;
  }

  await writeFile(filePath, result.join("\n"));
  const syncResult2 = await gitSyncVault();
  return `Added to ${section} in daily note. (${syncResult2})`;
}

async function handleGetDaily(args: any): Promise<string> {
  const dateStr = args?.date;
  const date = dateStr || new Date().toISOString().split("T")[0];
  const filePath = join(OBSIDIAN_VAULT, "daily", `${date}.md`);

  try {
    await stat(filePath);
    const content = await readFile(filePath, "utf-8");
    return content.length > 4000 ? content.substring(0, 4000) + "\n... (truncated)" : content;
  } catch {
    return `No daily note found for ${date}. Use add_to_daily to create one.`;
  }
}

async function handleUpdateWeekly(): Promise<string> {
  try {
    const path = await updateWeeklyNote();
    return `Weekly note updated: ${path}`;
  } catch (error: any) {
    return `Failed to update weekly note: ${error.message}`;
  }
}

async function handleToolCall(name: string, args: any): Promise<string> {
  switch (name) {
    case "check_email": return handleCheckEmail(args);
    case "check_calendar": return handleCheckCalendar();
    case "create_calendar_event": return handleCreateCalendarEvent(args);
    case "web_search": return handleWebSearch(args);
    case "browse_dev": return handleBrowseDev(args);
    case "create_note": return handleCreateNote(args);
    case "read_note": return handleReadNote(args);
    case "search_notes": return handleSearchNotes(args);
    case "edit_note": return handleEditNote(args);
    case "list_notes": return handleListNotes(args);
    case "get_weather": return handleGetWeather(args);
    case "add_to_daily": return handleAddToDaily(args);
    case "get_daily": return handleGetDaily(args);
    case "update_weekly": return handleUpdateWeekly();
    default: return `Unknown tool: ${name}`;
  }
}

// ============================================================
// MCP stdio transport
// ============================================================

async function writeResponse(id: any, result: any) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  process.stdout.write(response);
}

async function writeError(id: any, code: number, message: string) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
  process.stdout.write(response);
}

const decoder = new TextDecoder();
let buffer = "";

async function processMessage(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      await writeResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "relay-tools", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      await writeResponse(id, { tools: TOOLS });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        await writeResponse(id, {
          content: [{ type: "text", text: result }],
        });
      } catch (error: any) {
        await writeResponse(id, {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id) {
        await writeError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// Read from stdin line by line
const reader = Bun.stdin.stream().getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.substring(0, newlineIdx).trim();
    buffer = buffer.substring(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      await processMessage(msg);
    } catch {
      // Skip malformed JSON
    }
  }
}
