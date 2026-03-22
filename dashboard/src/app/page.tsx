"use client";

import { useState, useEffect } from "react";

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export default function Dashboard() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<"chat" | "notes" | "memory">("chat");

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 10000);
    return () => clearInterval(interval);
  }, []);

  async function fetchMessages() {
    try {
      const res = await fetch("/api/messages");
      if (res.ok) setMessages(await res.json());
    } catch {}
  }

  async function send() {
    if (!command.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      setCommand("");
      setTimeout(fetchMessages, 3000);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Relay Dashboard</h1>
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Logout
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["chat", "notes", "memory"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Command input */}
      <div className="flex gap-2 mb-6">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Send command to bot via Telegram..."
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={send}
          disabled={sending}
          className="bg-zinc-100 text-zinc-900 px-4 py-2 rounded-lg text-sm font-medium hover:bg-zinc-200 disabled:opacity-50"
        >
          {sending ? "..." : "Send"}
        </button>
      </div>

      {/* Messages */}
      {tab === "chat" && (
        <div className="space-y-3">
          {messages.length === 0 && (
            <p className="text-zinc-500 text-sm">No messages yet. Send a command above.</p>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`p-3 rounded-lg text-sm ${
                m.role === "user" ? "bg-zinc-800 border border-zinc-700" : "bg-zinc-900 border border-zinc-800"
              }`}
            >
              <div className="flex justify-between mb-1">
                <span className="text-xs font-medium text-zinc-400">
                  {m.role === "user" ? "You" : "Bot"}
                </span>
                <span className="text-xs text-zinc-600">
                  {new Date(m.created_at).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "notes" && (
        <p className="text-zinc-500 text-sm">Notes viewer coming soon — reads from Obsidian vault via GitHub.</p>
      )}

      {tab === "memory" && (
        <p className="text-zinc-500 text-sm">Memory browser coming soon — reads from Supabase memory table.</p>
      )}
    </div>
  );
}
