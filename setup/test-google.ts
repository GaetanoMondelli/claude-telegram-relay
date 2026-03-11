/**
 * Test Google integration (Gmail + Calendar)
 * Run: bun run test:google
 */

import { getAccessToken } from "../src/google-auth.ts";
import { getUnreadEmails, formatEmails } from "../src/gmail.ts";
import { getTodayEvents, formatEvents } from "../src/calendar.ts";

async function main() {
  console.log("=== Testing Google Integration ===\n");

  // 1. Check tokens
  const token = await getAccessToken();
  if (!token) {
    console.error("No valid Google token. Run: bun run setup:google");
    process.exit(1);
  }
  console.log("Token: OK\n");

  // 2. Test Gmail
  console.log("--- Gmail (read-only) ---");
  const emails = await getUnreadEmails(5);
  console.log(formatEmails(emails));
  console.log();

  // 3. Test Calendar
  console.log("--- Calendar (read-only) ---");
  const events = await getTodayEvents();
  console.log(formatEvents(events));
  console.log();

  console.log("Google integration working!");
}

main();
