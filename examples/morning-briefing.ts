/**
 * Morning Briefing
 *
 * Sends a daily summary via Telegram: weather, calendar, emails, goals.
 * Reads config from config/scheduled.json (copy from scheduled.example.json).
 *
 * Schedule with cron:
 *   0 8 * * * cd /path/to/relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/briefing.log 2>&1
 *
 * Or run manually: bun run briefing
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import { getUnreadEmails, formatEmails } from "../src/gmail.ts";
import { getTodayEvents, formatEvents } from "../src/calendar.ts";
import { getAccessToken } from "../src/google-auth.ts";
import { generateDailyNote } from "../src/daily-note.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const USER_NAME = process.env.USER_NAME || "";

// ============================================================
// LOAD CONFIG
// ============================================================

interface BriefingConfig {
  briefings: Array<{
    name: string;
    enabled: boolean;
    cron: string;
    sections: {
      weather?: { enabled: boolean; city: string };
      calendar?: { enabled: boolean };
      email?: { enabled: boolean; maxEmails?: number };
      goals?: { enabled: boolean };
    };
    message_style?: string;
  }>;
}

async function loadConfig(): Promise<BriefingConfig> {
  try {
    const content = await readFile(join(PROJECT_ROOT, "config", "scheduled.json"), "utf-8");
    return JSON.parse(content);
  } catch {
    // Fallback defaults
    return {
      briefings: [
        {
          name: "morning",
          enabled: true,
          cron: "0 8 * * *",
          sections: {
            weather: { enabled: true, city: "London" },
            calendar: { enabled: true },
            email: { enabled: true, maxEmails: 10 },
            goals: { enabled: true },
          },
        },
      ],
    };
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// DATA FETCHERS
// ============================================================

async function getWeather(city: string): Promise<string> {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
    if (!res.ok) return "Weather unavailable";
    return (await res.text()).trim();
  } catch {
    return "Weather unavailable";
  }
}

async function getActiveGoals(): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return "";

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data } = await supabase.rpc("get_active_goals");
    if (!data?.length) return "";
    return data
      .map((g: any) => {
        const deadline = g.deadline ? ` (by ${new Date(g.deadline).toLocaleDateString()})` : "";
        return `  - ${g.content}${deadline}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function getCryptoPrice(token: string): Promise<string> {
  try {
    const id = token.toLowerCase() === "qnt" ? "quant-network" : token.toLowerCase();
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,eur&include_24hr_change=true`
    );
    if (!res.ok) return `${token}: price unavailable`;
    const data = await res.json();
    const info = data[id];
    if (!info) return `${token}: not found`;
    const change = info.usd_24h_change?.toFixed(1) || "?";
    const arrow = parseFloat(change) >= 0 ? "↑" : "↓";
    return `${token}: $${info.usd?.toFixed(2)} / €${info.eur?.toFixed(2)} (${arrow}${change}% 24h)`;
  } catch {
    return `${token}: price unavailable`;
  }
}

// ============================================================
// BUILD & SEND BRIEFING
// ============================================================

async function buildBriefing(): Promise<string> {
  const config = await loadConfig();
  const briefing = config.briefings.find((b) => b.name === "morning" && b.enabled);
  if (!briefing) {
    console.log("Morning briefing is disabled in config.");
    process.exit(0);
  }

  const sections = briefing.sections;
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const parts: string[] = [];

  // Header
  const greeting = USER_NAME ? `Good morning, ${USER_NAME}!` : "Good morning!";
  parts.push(`*${greeting}*\n${dateStr}\n`);

  // Generate daily note (carries over todos, fetches email/calendar)
  if (sections.daily_note?.enabled) {
    try {
      const notePath = await generateDailyNote();
      parts.push(`📝 Daily note created: ${notePath.split("/").pop()}\n`);
    } catch (error) {
      console.error("Daily note error:", error);
    }
  }

  // Weather
  if (sections.weather?.enabled) {
    const weather = await getWeather(sections.weather.city);
    parts.push(`*☁️ Weather*\n${weather}\n`);
  }

  // Crypto
  if (sections.crypto?.enabled && sections.crypto.tokens?.length) {
    const prices = await Promise.all(
      sections.crypto.tokens.map((t: string) => getCryptoPrice(t))
    );
    parts.push(`*📈 Crypto*\n${prices.join("\n")}\n`);
  }

  // Calendar
  if (sections.calendar?.enabled) {
    const token = await getAccessToken();
    if (token) {
      const events = await getTodayEvents();
      const formatted = formatEvents(events);
      parts.push(`*📅 Calendar*\n${formatted}\n`);
    }
  }

  // Email (brief — 2 lines max)
  if (sections.email?.enabled) {
    const token = await getAccessToken();
    if (token) {
      const emails = await getUnreadEmails(sections.email.maxEmails || 5);
      const formatted = formatEmails(emails);
      // Keep it short — first 2 lines or summary
      const emailLines = formatted.split("\n").filter((l: string) => l.trim());
      const brief = emailLines.slice(0, 3).join("\n");
      parts.push(`*📧 Email* (${emailLines.length} unread)\n${brief}\n`);
    }
  }

  // Goals
  if (sections.goals?.enabled) {
    const goals = await getActiveGoals();
    if (goals) {
      parts.push(`*🎯 Goals*\n${goals}\n`);
    }
  }

  // Carried todos from yesterday
  const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || join(process.env.HOME || "~", "dev", "obsidian");
  const todayDate = now.toISOString().split("T")[0];
  try {
    const dailyContent = await readFile(join(OBSIDIAN_VAULT, "daily", `${todayDate}.md`), "utf-8");
    const todoLines = dailyContent.split("\n").filter((l: string) => l.match(/^- \[ \]/));
    if (todoLines.length) {
      parts.push(`*📋 Today's Todos* (${todoLines.length})\n${todoLines.slice(0, 5).join("\n")}\n`);
    }
  } catch {}

  parts.push("---\n_Reply to update your daily note_");

  return parts.join("\n");
}

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const briefing = await buildBriefing();

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();
