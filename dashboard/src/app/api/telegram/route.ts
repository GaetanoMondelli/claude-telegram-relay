import { NextRequest, NextResponse } from "next/server";
import { sendCommand } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  const { command } = await req.json();
  if (!command) return NextResponse.json({ error: "Missing command" }, { status: 400 });

  const result = await sendCommand(command);
  return NextResponse.json(result);
}
