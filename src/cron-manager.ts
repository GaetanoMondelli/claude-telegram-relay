/**
 * Cron Manager — CRUD for user crontab entries
 *
 * Each managed job has a comment line above it:
 *   # cron:name: Morning Briefing | desc: Daily summary at 8am
 *   0 8 * * * cd /home/gaetano/dev/claude-telegram-relay && bun run briefing >> /tmp/briefing.log 2>&1
 *
 * Disabled jobs get the cron line commented out:
 *   # cron:name: Morning Briefing | desc: Daily summary at 8am
 *   # DISABLED: 0 8 * * * cd ...
 */

import { spawn } from "bun";
import { dirname } from "path";
import { unlink } from "fs/promises";

const PROJECT_DIR = dirname(dirname(import.meta.path));

export interface CronJob {
  name: string;
  description: string;
  schedule: string;
  command: string;
  enabled: boolean;
}

const HEADER_RE = /^# cron:name:\s*(.+?)\s*\|\s*desc:\s*(.+)$/;
const DISABLED_RE = /^# DISABLED:\s*(.+)$/;

/**
 * Parse current crontab into structured jobs
 */
export async function listJobs(): Promise<CronJob[]> {
  const raw = await readCrontab();
  const lines = raw.split("\n");
  const jobs: CronJob[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADER_RE);
    if (!match) continue;

    const name = match[1].trim();
    const description = match[2].trim();
    const nextLine = lines[i + 1] || "";

    const disabledMatch = nextLine.match(DISABLED_RE);
    if (disabledMatch) {
      const full = disabledMatch[1];
      const { schedule, command } = parseCronLine(full);
      jobs.push({ name, description, schedule, command, enabled: false });
      i++;
    } else if (nextLine.trim() && !nextLine.startsWith("#")) {
      const { schedule, command } = parseCronLine(nextLine);
      jobs.push({ name, description, schedule, command, enabled: true });
      i++;
    }
  }

  return jobs;
}

/**
 * Enable a job by name
 */
export async function enableJob(name: string): Promise<boolean> {
  const raw = await readCrontab();
  const lines = raw.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADER_RE);
    if (!match || match[1].trim().toLowerCase() !== name.toLowerCase()) continue;

    const nextLine = lines[i + 1] || "";
    const disabledMatch = nextLine.match(DISABLED_RE);
    if (disabledMatch) {
      lines[i + 1] = disabledMatch[1];
      found = true;
    }
    break;
  }

  if (found) await writeCrontab(lines.join("\n"));
  return found;
}

/**
 * Disable a job by name
 */
export async function disableJob(name: string): Promise<boolean> {
  const raw = await readCrontab();
  const lines = raw.split("\n");
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADER_RE);
    if (!match || match[1].trim().toLowerCase() !== name.toLowerCase()) continue;

    const nextLine = lines[i + 1] || "";
    if (!nextLine.startsWith("# DISABLED:") && nextLine.trim() && !nextLine.startsWith("#")) {
      lines[i + 1] = `# DISABLED: ${nextLine}`;
      found = true;
    }
    break;
  }

  if (found) await writeCrontab(lines.join("\n"));
  return found;
}

/**
 * Add a new cron job
 */
export async function addJob(job: CronJob): Promise<void> {
  const raw = await readCrontab();
  const header = `# cron:name: ${job.name} | desc: ${job.description}`;
  const logFile = `/tmp/${job.name.toLowerCase().replace(/\s+/g, "-")}.log`;
  const fullCmd = `cd ${PROJECT_DIR} && bun run ${job.command} >> ${logFile} 2>&1`;
  const cronLine = `${job.schedule} ${fullCmd}`;
  const newEntry = job.enabled ? `${header}\n${cronLine}` : `${header}\n# DISABLED: ${cronLine}`;

  const updated = raw.trimEnd() + "\n" + newEntry + "\n";
  await writeCrontab(updated);
}

/**
 * Remove a job by name
 */
export async function removeJob(name: string): Promise<boolean> {
  const raw = await readCrontab();
  const lines = raw.split("\n");
  let found = false;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADER_RE);
    if (match && match[1].trim().toLowerCase() === name.toLowerCase()) {
      found = true;
      // Skip the header and the next line (the cron entry)
      if (i + 1 < lines.length && (lines[i + 1].match(DISABLED_RE) || (!lines[i + 1].startsWith("#") && lines[i + 1].trim()))) {
        i++;
      }
      continue;
    }
    result.push(lines[i]);
  }

  if (found) await writeCrontab(result.join("\n"));
  return found;
}

/**
 * Run a job immediately (one-shot)
 */
export async function runJobNow(name: string): Promise<{ ok: boolean; output: string }> {
  const jobs = await listJobs();
  const job = jobs.find(j => j.name.toLowerCase() === name.toLowerCase());
  if (!job) return { ok: false, output: `Job "${name}" not found` };

  try {
    const proc = spawn(["bash", "-c", job.command], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
    });
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, output: stdout || stderr || "Done" };
  } catch (error: any) {
    return { ok: false, output: error.message };
  }
}

// ============================================================
// CRONTAB HELPERS
// ============================================================

async function readCrontab(): Promise<string> {
  try {
    const proc = spawn(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  } catch {
    return "";
  }
}

async function writeCrontab(content: string): Promise<void> {
  const tmpFile = `/tmp/crontab-${Date.now()}`;
  await Bun.write(tmpFile, content);
  const proc = spawn(["crontab", tmpFile], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  await unlink(tmpFile).catch(() => {});
}

function parseCronLine(line: string): { schedule: string; command: string } {
  const trimmed = line.trim();
  // Cron schedule is the first 5 fields
  const parts = trimmed.split(/\s+/);
  const schedule = parts.slice(0, 5).join(" ");
  const command = parts.slice(5).join(" ");
  return { schedule, command };
}

/**
 * Describe a cron schedule in human-readable form
 */
export function describeCron(schedule: string): string {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [min, hour, dom, mon, dow] = parts;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let time = "";
  if (hour !== "*" && min !== "*") {
    time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  if (dom === "*" && mon === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*" && mon === "*" && dow !== "*") {
    const dayName = days[parseInt(dow)] || dow;
    return `${dayName}s at ${time}`;
  }
  return schedule;
}
