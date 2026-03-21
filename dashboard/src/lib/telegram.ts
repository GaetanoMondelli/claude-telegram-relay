const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const USER_ID = process.env.TELEGRAM_USER_ID!;

export async function sendCommand(text: string): Promise<{ ok: boolean; message_id?: number }> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: USER_ID, text }),
  });
  return res.json();
}
