/**
 * Google OAuth2 Authentication
 *
 * Handles OAuth2 flow for Gmail and Calendar (read-only scopes).
 * Run `bun run setup:google` to authenticate.
 *
 * Tokens are stored in ~/.claude-relay/google-tokens.json
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const TOKEN_FILE = join(RELAY_DIR, "google-tokens.json");

const REDIRECT_URI = "http://127.0.0.1:3456";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

export async function loadTokens(): Promise<GoogleTokens | null> {
  try {
    const content = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: GoogleTokens): Promise<void> {
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Refresh the access token using the refresh token.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (!tokens?.refresh_token) return null;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Check if token is still valid (with 5 min buffer)
  if (tokens.expiry_date > Date.now() + 300_000) {
    return tokens.access_token;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      console.error("Token refresh failed:", await res.text());
      return null;
    }

    const data = await res.json();
    const updated: GoogleTokens = {
      access_token: data.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    };

    await saveTokens(updated);
    return updated.access_token;
  } catch (error) {
    console.error("Token refresh error:", error);
    return null;
  }
}

/**
 * Get a valid access token (refreshes if needed).
 */
export async function getAccessToken(): Promise<string | null> {
  return refreshAccessToken();
}

/**
 * Generate the OAuth2 authorization URL.
 */
export function getAuthUrl(): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code: string): Promise<boolean> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!res.ok) {
      console.error("Code exchange failed:", await res.text());
      return false;
    }

    const data = await res.json();
    const tokens: GoogleTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: Date.now() + data.expires_in * 1000,
    };

    await saveTokens(tokens);
    return true;
  } catch (error) {
    console.error("Code exchange error:", error);
    return false;
  }
}

/**
 * Start a temporary local server to capture the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
export function startCallbackServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port: 3456,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/" || url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          // Shut down after handling
          setTimeout(() => server.stop(), 500);

          if (error) {
            reject(new Error(`OAuth error: ${error}`));
            return new Response(
              "<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>",
              { headers: { "Content-Type": "text/html" } }
            );
          }

          if (code) {
            resolve(code);
            return new Response(
              "<html><body><h2>Authorization successful!</h2><p>You can close this tab and go back to the terminal.</p></body></html>",
              { headers: { "Content-Type": "text/html" } }
            );
          }

          reject(new Error("No code received"));
          return new Response("No code received", { status: 400 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.stop();
      reject(new Error("Timed out waiting for authorization"));
    }, 120_000);
  });
}
