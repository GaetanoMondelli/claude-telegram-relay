/**
 * Google OAuth2 Setup
 *
 * Interactive setup to authenticate Gmail and Calendar (read-only).
 * Starts a local server on port 3456 to capture the OAuth callback.
 * Run: bun run setup:google
 */

import { getAuthUrl, exchangeCode, loadTokens, startCallbackServer } from "../src/google-auth.ts";

async function main() {
  console.log("=== Google OAuth2 Setup (Read-Only) ===\n");

  // Check for existing tokens
  const existing = await loadTokens();
  if (existing?.refresh_token) {
    console.log("Existing tokens found. Re-running will replace them.\n");
  }

  // Check env vars
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env\n");
    console.log("To get these:");
    console.log("1. Go to https://console.cloud.google.com/apis/credentials");
    console.log("2. Create a project (or select existing)");
    console.log("3. Enable Gmail API and Google Calendar API");
    console.log("4. Go to Credentials > Create Credentials > OAuth client ID");
    console.log("5. Application type: Web application");
    console.log("6. Add http://localhost:3456/callback as an Authorized redirect URI");
    console.log("7. Copy Client ID and Client Secret to .env");
    console.log("\nThen run this again: bun run setup:google");
    process.exit(1);
  }

  const authUrl = getAuthUrl();
  if (!authUrl) {
    console.error("Could not generate auth URL");
    process.exit(1);
  }

  console.log("Starting local callback server on port 3456...\n");
  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nSign in, authorize read-only access, and you'll be redirected back.\n");
  console.log("Waiting for authorization...");

  try {
    const code = await startCallbackServer();
    console.log("Code received! Exchanging for tokens...");

    const success = await exchangeCode(code);
    if (success) {
      console.log("\nAuthentication successful!");
      console.log("Tokens saved. Gmail and Calendar are now available.");
      console.log("Test with: bun run test:google");
    } else {
      console.error("\nAuthentication failed. Check your client ID/secret and try again.");
      process.exit(1);
    }
  } catch (error: any) {
    console.error("\nAuth failed:", error.message);
    process.exit(1);
  }
}

main();
