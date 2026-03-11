/**
 * Gmail — Read-Only
 *
 * Fetches unread/important emails. No modifications, no deletions, no sending.
 * Requires Google OAuth2 tokens (run `bun run setup:google` first).
 */

import { getAccessToken } from "./google-auth.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
  date: string;
  isImportant: boolean;
}

/**
 * Fetch recent unread emails (last 24h or up to maxResults).
 */
export async function getUnreadEmails(maxResults = 10): Promise<EmailSummary[]> {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const query = "is:unread newer_than:1d";
    const res = await fetch(
      `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      console.error("Gmail list error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    if (!data.messages?.length) return [];

    // Fetch details for each message
    const emails: EmailSummary[] = [];
    for (const msg of data.messages.slice(0, maxResults)) {
      const detail = await fetchMessageDetail(token, msg.id);
      if (detail) emails.push(detail);
    }

    return emails;
  } catch (error) {
    console.error("Gmail fetch error:", error);
    return [];
  }
}

/**
 * Fetch a single email's metadata (no body content for privacy).
 */
async function fetchMessageDetail(token: string, messageId: string): Promise<EmailSummary | null> {
  try {
    const res = await fetch(
      `${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return null;

    const msg = await res.json();
    const headers = msg.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const labelIds: string[] = msg.labelIds || [];

    return {
      from: getHeader("From"),
      subject: getHeader("Subject"),
      snippet: msg.snippet || "",
      date: getHeader("Date"),
      isImportant: labelIds.includes("IMPORTANT"),
    };
  } catch {
    return null;
  }
}

/**
 * Format emails into a readable summary string.
 */
export function formatEmails(emails: EmailSummary[]): string {
  if (!emails.length) return "No unread emails.";

  const important = emails.filter((e) => e.isImportant);
  const regular = emails.filter((e) => !e.isImportant);

  const lines: string[] = [];

  if (important.length) {
    lines.push(`*Important (${important.length}):*`);
    for (const e of important) {
      lines.push(`  - ${e.from}: ${e.subject}`);
      if (e.snippet) lines.push(`    ${e.snippet.substring(0, 100)}`);
    }
  }

  if (regular.length) {
    lines.push(`Other unread (${regular.length}):`);
    for (const e of regular.slice(0, 5)) {
      lines.push(`  - ${e.from}: ${e.subject}`);
    }
    if (regular.length > 5) {
      lines.push(`  ... and ${regular.length - 5} more`);
    }
  }

  return lines.join("\n");
}
