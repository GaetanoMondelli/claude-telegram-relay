/**
 * Daily Note Generator
 *
 * Generates a daily note from template, carries over uncompleted todos,
 * fetches email and calendar summaries, saves to Obsidian vault.
 *
 * Run standalone: bun run src/daily-note.ts
 * Or import: import { generateDailyNote } from "./daily-note.ts"
 */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { spawn } from "bun";
import { getAccessToken } from "./google-auth.ts";
import { getUnreadEmails, formatEmails } from "./gmail.ts";
import { getTodayEvents, formatEvents } from "./calendar.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(process.env.HOME || "~", "dev", "obsidian");
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// Helpers
// ============================================================

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getWeekday(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: USER_TIMEZONE, weekday: "long" });
}

function getDatePretty(date: Date): string {
  return date.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getYesterday(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d;
}

// ============================================================
// Carry over todos from yesterday
// ============================================================

async function getCarriedTodos(date: Date): Promise<string> {
  const yesterday = getYesterday(date);
  const yesterdayFile = join(OBSIDIAN_VAULT, "daily", `${getDateStr(yesterday)}.md`);

  try {
    await stat(yesterdayFile);
    const content = await readFile(yesterdayFile, "utf-8");

    const lines = content.split("\n");
    let inTodoSection = false;
    const uncompleted: string[] = [];

    for (const line of lines) {
      if (line.startsWith("## ") && line.includes("To-Do")) {
        inTodoSection = true;
        continue;
      }
      if (line.startsWith("## ") && inTodoSection) {
        break;
      }
      if (inTodoSection && line.match(/^- \[ \] /)) {
        uncompleted.push(line);
      }
    }

    if (uncompleted.length > 0) {
      return uncompleted.join("\n");
    }
  } catch {
    // No yesterday note — that's fine
  }

  return "- [ ] ";
}

// ============================================================
// Fetch email summary
// ============================================================

async function getEmailSummary(): Promise<string> {
  try {
    const token = await getAccessToken();
    if (!token) return "Not connected — run `bun run setup:google`";
    const emails = await getUnreadEmails(10);
    return formatEmails(emails);
  } catch {
    return "Not connected";
  }
}

// ============================================================
// Fetch calendar summary
// ============================================================

async function getCalendarSummary(): Promise<string> {
  try {
    const token = await getAccessToken();
    if (!token) return "Not connected — run `bun run setup:google`";
    const events = await getTodayEvents();
    return formatEvents(events);
  } catch {
    return "Not connected";
  }
}

// ============================================================
// Git sync
// ============================================================

async function gitSync(): Promise<void> {
  try {
    const add = spawn(["git", "add", "-A"], { cwd: OBSIDIAN_VAULT, stdout: "pipe", stderr: "pipe" });
    await add.exited;
    const commit = spawn(["git", "commit", "-m", `Daily note ${getDateStr(new Date())}`], {
      cwd: OBSIDIAN_VAULT, stdout: "pipe", stderr: "pipe",
    });
    await commit.exited;
    const push = spawn(["git", "push"], { cwd: OBSIDIAN_VAULT, stdout: "pipe", stderr: "pipe" });
    await push.exited;
  } catch {
    // Git sync is best-effort
  }
}

// ============================================================
// Generate daily note
// ============================================================

export async function generateDailyNote(date?: Date): Promise<string> {
  const today = date || new Date();
  const dateStr = getDateStr(today);
  const dailyDir = join(OBSIDIAN_VAULT, "daily");
  const filePath = join(dailyDir, `${dateStr}.md`);

  // Check if note already exists
  try {
    await stat(filePath);
    console.log(`Daily note already exists: ${filePath}`);
    return filePath;
  } catch {
    // Note doesn't exist — create it
  }

  // Load template
  let template: string;
  try {
    template = await readFile(join(PROJECT_ROOT, "config", "templates", "daily.md"), "utf-8");
  } catch {
    console.error("Could not read daily template from config/templates/daily.md");
    process.exit(1);
  }

  // Gather data
  const [carriedTodos, emailSummary, calendarSummary] = await Promise.all([
    getCarriedTodos(today),
    getEmailSummary(),
    getCalendarSummary(),
  ]);

  // Fill template
  const note = template
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{weekday\}\}/g, getWeekday(today))
    .replace(/\{\{date_pretty\}\}/g, getDatePretty(today))
    .replace(/\{\{carried_todos\}\}/g, carriedTodos)
    .replace(/\{\{email_summary\}\}/g, emailSummary)
    .replace(/\{\{calendar_summary\}\}/g, calendarSummary);

  // Write file
  await mkdir(dailyDir, { recursive: true });
  await writeFile(filePath, note);
  console.log(`Daily note created: ${filePath}`);

  // Git sync
  await gitSync();

  return filePath;
}

// ============================================================
// Standalone execution
// ============================================================

if (import.meta.main) {
  const path = await generateDailyNote();
  console.log(`Done: ${path}`);
}
