/**
 * Google Calendar
 *
 * Fetches today's events and creates new events.
 * Requires Google OAuth2 tokens (run `bun run setup:google` first).
 */

import { getAccessToken } from "./google-auth.ts";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  location?: string;
  isAllDay: boolean;
}

/**
 * Fetch today's calendar events.
 */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const token = await getAccessToken();
  if (!token) return [];

  const tz = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Start and end of today in the user's timezone
  const now = new Date();
  const startOfDay = new Date(now.toLocaleDateString("en-US", { timeZone: tz }));
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  try {
    const params = new URLSearchParams({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "20",
      timeZone: tz,
    });

    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) {
      console.error("Calendar error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    if (!data.items?.length) return [];

    return data.items.map((event: any) => ({
      summary: event.summary || "(No title)",
      start: event.start?.dateTime || event.start?.date || "",
      end: event.end?.dateTime || event.end?.date || "",
      location: event.location || undefined,
      isAllDay: !!event.start?.date && !event.start?.dateTime,
    }));
  } catch (error) {
    console.error("Calendar fetch error:", error);
    return [];
  }
}

/**
 * Format events into a readable summary string.
 */
export function formatEvents(events: CalendarEvent[]): string {
  if (!events.length) return "No events today.";

  const tz = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

  return events
    .map((e) => {
      if (e.isAllDay) {
        return `  - All day: ${e.summary}`;
      }
      const time = new Date(e.start).toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const loc = e.location ? ` (${e.location})` : "";
      return `  - ${time} ${e.summary}${loc}`;
    })
    .join("\n");
}

/**
 * Create a new calendar event. Returns the event link.
 */
export async function createEvent(opts: {
  summary: string;
  start: string;       // ISO 8601 datetime e.g. "2026-03-10T14:00:00"
  end: string;         // ISO 8601 datetime
  description?: string;
  location?: string;
  attendees?: string[]; // email addresses
}): Promise<{ link: string; id: string } | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const tz = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const event: any = {
    summary: opts.summary,
    start: { dateTime: opts.start, timeZone: tz },
    end: { dateTime: opts.end, timeZone: tz },
    conferenceData: {
      createRequest: {
        requestId: `relay-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  if (opts.description) event.description = opts.description;
  if (opts.location) event.location = opts.location;
  if (opts.attendees?.length) {
    event.attendees = opts.attendees.map((email) => ({ email }));
  }

  try {
    const res = await fetch(
      `${CALENDAR_API}/calendars/primary/events?conferenceDataVersion=1`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );

    if (!res.ok) {
      console.error("Create event error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return {
      link: data.hangoutLink || data.htmlLink || "",
      id: data.id,
    };
  } catch (error) {
    console.error("Create event error:", error);
    return null;
  }
}
