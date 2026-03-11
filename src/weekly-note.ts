/**
 * Weekly Note Generator
 *
 * Generates/updates a weekly note from template.
 * Reads daily notes for the current week, aggregates stats.
 *
 * Run standalone: bun run src/weekly-note.ts
 * Or import: import { generateWeeklyNote, updateWeeklyNote } from "./weekly-note.ts"
 */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { spawn } from "bun";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(process.env.HOME || "~", "dev", "obsidian");
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// Helpers
// ============================================================

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

/** Get ISO week number */
function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Get Monday of the week containing the given date */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Get Sunday of the week containing the given date */
function getSunday(date: Date): Date {
  const monday = getMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return sunday;
}

/** Get all days (Mon-Sun) for the week */
function getWeekDays(date: Date): Date[] {
  const monday = getMonday(date);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

/** Get the week filename, e.g. 2026-W11.md */
function getWeekFileName(date: Date): string {
  const year = date.getFullYear();
  const week = getWeekNumber(date);
  return `${year}-W${String(week).padStart(2, "0")}.md`;
}

// ============================================================
// Read and parse daily notes
// ============================================================

interface DailyData {
  date: string;
  exists: boolean;
  completedTodos: string[];
  uncompletedTodos: string[];
  weight: number | null;
  steps: number | null;
  exercise: string | null;
}

async function parseDailyNote(date: Date): Promise<DailyData> {
  const dateStr = getDateStr(date);
  const filePath = join(OBSIDIAN_VAULT, "daily", `${dateStr}.md`);
  const data: DailyData = {
    date: dateStr,
    exists: false,
    completedTodos: [],
    uncompletedTodos: [],
    weight: null,
    steps: null,
    exercise: null,
  };

  try {
    await stat(filePath);
    data.exists = true;
  } catch {
    return data;
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  let currentSection = "";

  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim().toLowerCase();
      continue;
    }

    // Parse todos
    if (currentSection.includes("to-do")) {
      if (line.match(/^- \[x\] /i)) {
        data.completedTodos.push(line.replace(/^- \[x\] /i, "").trim());
      } else if (line.match(/^- \[ \] /) && !line.includes("___")) {
        data.uncompletedTodos.push(line.replace(/^- \[ \] /, "").trim());
      }
    }

    // Parse health
    if (currentSection.includes("health")) {
      // Weight: look for "Weighed myself: X kg" or similar patterns
      const weightMatch = line.match(/weighed.*?:\s*([\d.]+)\s*kg/i);
      if (weightMatch) {
        data.weight = parseFloat(weightMatch[1]);
      }

      // Steps
      const stepsMatch = line.match(/steps:\s*([\d,]+)/i);
      if (stepsMatch) {
        data.steps = parseInt(stepsMatch[1].replace(/,/g, ""), 10);
      }

      // Exercise
      const exerciseMatch = line.match(/exercise:\s*(.+)/i);
      if (exerciseMatch && exerciseMatch[1].trim() && exerciseMatch[1].trim() !== "___") {
        data.exercise = exerciseMatch[1].trim();
      }
    }
  }

  return data;
}

// ============================================================
// Git sync
// ============================================================

async function gitSync(): Promise<void> {
  try {
    const add = spawn(["git", "add", "-A"], { cwd: OBSIDIAN_VAULT, stdout: "pipe", stderr: "pipe" });
    await add.exited;
    const commit = spawn(["git", "commit", "-m", `Weekly note ${getDateStr(new Date())}`], {
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
// Generate weekly note
// ============================================================

export async function generateWeeklyNote(date?: Date): Promise<string> {
  const today = date || new Date();
  const weekDir = join(OBSIDIAN_VAULT, "weekly");
  const fileName = getWeekFileName(today);
  const filePath = join(weekDir, fileName);

  // Load template
  let template: string;
  try {
    template = await readFile(join(PROJECT_ROOT, "config", "templates", "weekly.md"), "utf-8");
  } catch {
    console.error("Could not read weekly template from config/templates/weekly.md");
    process.exit(1);
  }

  // Get all daily data for the week
  const weekDays = getWeekDays(today);
  const dailyData = await Promise.all(weekDays.map(parseDailyNote));

  // Aggregate stats
  const weights = dailyData.filter((d) => d.weight !== null).map((d) => d.weight!);
  const avgWeight = weights.length > 0
    ? (weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(1)
    : "___";

  const steps = dailyData.filter((d) => d.steps !== null).map((d) => d.steps!);
  const totalSteps = steps.length > 0
    ? steps.reduce((a, b) => a + b, 0).toLocaleString()
    : "___";

  const exerciseDays = dailyData.filter((d) => d.exercise !== null).length;

  const allCompleted = dailyData.flatMap((d) => d.completedTodos);
  const completedTasks = allCompleted.length > 0
    ? allCompleted.map((t) => `- [x] ${t}`).join("\n")
    : "None this week.";

  // Carried = uncompleted from the last daily note that exists
  const lastDay = [...dailyData].reverse().find((d) => d.exists);
  const carriedTasks = lastDay && lastDay.uncompletedTodos.length > 0
    ? lastDay.uncompletedTodos.map((t) => `- [ ] ${t}`).join("\n")
    : "All done!";

  // Daily note links
  const dailyLinks = weekDays
    .map((d) => {
      const dateStr = getDateStr(d);
      const dayData = dailyData.find((dd) => dd.date === dateStr);
      const exists = dayData?.exists ? "" : " (no note)";
      const weekday = d.toLocaleDateString("en-US", { timeZone: USER_TIMEZONE, weekday: "short" });
      return `- ${weekday}: [[daily/${dateStr}]]${exists}`;
    })
    .join("\n");

  // Weekly summary placeholder
  const existingDays = dailyData.filter((d) => d.exists).length;
  const weeklySummary = `${existingDays} daily notes this week. ${allCompleted.length} tasks completed.`;

  // Fill template
  const weekNum = getWeekNumber(today);
  const year = today.getFullYear();
  const startDate = getDateStr(getMonday(today));
  const endDate = getDateStr(getSunday(today));

  let note = template
    .replace(/\{\{week_number\}\}/g, String(weekNum))
    .replace(/\{\{year\}\}/g, String(year))
    .replace(/\{\{start_date\}\}/g, startDate)
    .replace(/\{\{end_date\}\}/g, endDate)
    .replace(/\{\{weekly_summary\}\}/g, weeklySummary)
    .replace(/\{\{completed_tasks\}\}/g, completedTasks)
    .replace(/\{\{carried_tasks\}\}/g, carriedTasks)
    .replace(/\{\{daily_links\}\}/g, dailyLinks);

  // Replace health stats
  note = note.replace(/Average weight: ___/, `Average weight: ${avgWeight} kg`);
  note = note.replace(/Total steps: ___/, `Total steps: ${totalSteps}`);
  note = note.replace(/Exercise days: ___/, `Exercise days: ${exerciseDays}/7`);

  // Write file
  await mkdir(weekDir, { recursive: true });
  await writeFile(filePath, note);
  console.log(`Weekly note created: ${filePath}`);

  // Git sync
  await gitSync();

  return filePath;
}

/** Alias: regenerate the weekly note with latest data */
export async function updateWeeklyNote(date?: Date): Promise<string> {
  return generateWeeklyNote(date);
}

// ============================================================
// Standalone execution
// ============================================================

if (import.meta.main) {
  const path = await generateWeeklyNote();
  console.log(`Done: ${path}`);
}
