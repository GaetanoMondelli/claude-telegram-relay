# Claude Telegram Relay

Personal AI assistant running on a Raspberry Pi, powered by Claude Code and accessible through Telegram. Acts as a central hub: chat, file manager (NAS), Obsidian knowledge base, code sessions, email, calendar, and web search.

Built with Bun, grammY, and Claude Code CLI. Uses Supabase for persistent memory with semantic search.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Raspberry Pi                                            │
│                                                          │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Telegram Bot  │  │ Claude CLI│  │ MCP Server       │  │
│  │ (grammY)      │──│ (spawned) │──│ email, calendar, │  │
│  │               │  │           │  │ notes, search,   │  │
│  └──────────────┘  └───────────┘  │ weather, files   │  │
│                                    └──────────────────┘  │
│  ┌────────────┐  ┌───────────┐  ┌────────────────────┐  │
│  │ Filebrowser │  │ Syncthing │  │ Samba              │  │
│  │ :8080       │  │ :8384     │  │ :445               │  │
│  └────────────┘  └───────────┘  │ shares: storage,   │  │
│                                  │ obsidian, dev      │  │
│  ┌────────────┐                  └────────────────────┘  │
│  │ Tailscale  │ VPN mesh for remote access               │
│  └────────────┘                                          │
└──────────────────────────────────────────────────────────┘
        │              │              │              │
   Telegram        GitHub         Google        Supabase
   (phone)       (git sync)   (Gmail, Cal)    (memory, embeddings)
                                    │
                              Obsidian vault
                           (synced via Syncthing)
```

**Access methods:** Telegram chat, Filebrowser web UI, SMB file shares, Tailscale VPN from anywhere.

## Features

- **Chat with Claude** -- text, voice messages, photos, documents. Context-aware with conversation history.
- **File manager / NAS** -- `/files` to browse, upload files via Telegram, access via Samba or Filebrowser web UI.
- **Obsidian notes** -- `/note` to create, `/notes` to search. Natural language note creation via MCP tools. Vault synced with Syncthing.
- **Code sessions** -- `/code <project>` for prompt mode through Telegram, `/code remote <project>` to connect via claude.ai/code.
- **Email & Calendar** -- Gmail inbox (read-only), Google Calendar (read + create events) via MCP tools.
- **Web search** -- `/search` or just ask naturally. Uses DuckDuckGo.
- **Service management** -- `/service start|stop|restart` for samba, filebrowser, syncthing via systemctl.
- **Access links** -- `/links` shows Tailscale and LAN URLs for all services.
- **Git sync** -- `/sync` pulls, commits local changes, and pushes Obsidian vault (or any ~/dev repo).
- **Daily briefings** -- scheduled morning messages with weather, calendar, email, goals.
- **Memory system** -- Supabase-backed semantic search over conversations, persistent facts and goals.
- **Voice transcription** -- Groq (cloud, free) or local Whisper via whisper-cpp.

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all capabilities |
| `/status` | Services, connections, and system status |
| `/code` | List ~/dev projects |
| `/code <project>` | Start code session via Telegram |
| `/code remote <project>` | Start session for claude.ai/code |
| `/code stop` | End active code session |
| `/files` | Browse ~/storage |
| `/files <path>` | List directory or read file |
| `/files search <query>` | Find files by name |
| `/files download <path>` | Get file via Telegram |
| `/note <title>` | Create an Obsidian note |
| `/notes` | List recent notes |
| `/notes search <query>` | Search vault content |
| `/notes read <name>` | Read a specific note |
| `/email` | Check unread Gmail |
| `/calendar` | Today's calendar events |
| `/search <query>` | Web search (DuckDuckGo) |
| `/dev` | Browse ~/dev projects (read-only) |
| `/dev <path>` | Browse project files |
| `/sync` | Git sync Obsidian vault |
| `/sync <repo>` | Git sync any ~/dev repo |
| `/links` | Show Tailscale + LAN access URLs |
| `/service` | Show service status |
| `/service start\|stop\|restart <name>` | Control a service (samba, filebrowser, syncthing, all) |
| `/clear` | Clear chat history |
| `/reset` | Full reset -- nuke all sessions |

Natural language also works: "search latest bun release", "add a note about...", "check my email".

## MCP Server Tools

The MCP server (`src/mcp-server.ts`) exposes tools that Claude calls automatically:

| Tool | Description |
|------|-------------|
| `check_email` | Fetch unread Gmail |
| `check_calendar` | Fetch today's calendar events |
| `create_calendar_event` | Create event with optional Meet link |
| `web_search` | Search via DuckDuckGo |
| `browse_dev` | Browse ~/dev projects (read-only) |
| `create_note` | Create Obsidian note |
| `read_note` | Read Obsidian note |
| `edit_note` | Append to or replace note content |
| `search_notes` | Search vault by title/content |
| `list_notes` | List notes in vault |
| `get_weather` | Current weather for a city |

## Services

| Service | Port | Description |
|---------|------|-------------|
| Filebrowser | 8080 | Web-based file manager for ~/storage |
| Syncthing | 8384 | File sync across devices (Obsidian vault) |
| Samba | 445 | Native file sharing -- shares: `storage`, `obsidian`, `dev` |
| Tailscale | -- | VPN mesh network for remote access from anywhere |

All services are managed via systemctl and controllable through the `/service` bot command.

## Setup

See [CLAUDE.md](CLAUDE.md) for the interactive setup guide. Run `claude` in this directory and it walks you through everything step by step:

1. Telegram bot (BotFather)
2. Supabase (memory + semantic search)
3. Profile personalization
4. Test the bot
5. Always-on services (PM2/systemd)
6. Scheduled briefings
7. Voice transcription
8. Google integration (Gmail + Calendar)

## Project Structure

```
src/
  relay.ts           # Core Telegram bot and command handlers
  mcp-server.ts      # MCP server with tools for Claude
  memory.ts          # Supabase memory (facts, goals, semantic search)
  gmail.ts           # Gmail API (read-only)
  calendar.ts        # Google Calendar API (read + create)
  google-auth.ts     # OAuth2 token management
  transcribe.ts      # Voice transcription (Groq / whisper-cpp)
config/
  profile.md         # User profile loaded on every message
  scheduled.json     # Briefing schedule config
examples/
  morning-briefing.ts  # Daily briefing script
  smart-checkin.ts     # Proactive check-in script
db/
  schema.sql         # Supabase database schema
supabase/
  functions/
    embed/           # Auto-embedding Edge Function
    search/          # Semantic search Edge Function
setup/
  install.ts         # Prerequisites checker
  setup-google.ts    # Google OAuth2 setup
  verify.ts          # Full health check
```

## Future Ideas

- **Obsidian LiveSync** -- CouchDB-based real-time vault sync (replace Syncthing for instant sync)
- **Voice responses** -- ElevenLabs TTS so the bot speaks back
- **Telegram inline buttons** -- confirmation prompts before taking actions (send email, create event)
- **Auto-backup cron** -- scheduled git push for all ~/dev repos
- **Health integrations** -- Apple Health, Fitbit API for automatic step/sleep tracking in daily notes
- **Weekly AI summaries** -- auto-generated weekly review from daily notes and conversations
- **Multi-agent system** -- specialized agents for research, content, finance routed via Telegram topics
- **Cloudflare Tunnel** -- public access to services without requiring Tailscale on every device
- **Home automation** -- Home Assistant integration for controlling lights, sensors, etc. via Telegram

## License

MIT
