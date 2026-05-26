const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";

export async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!PAPERCLIP_API_KEY) throw new Error("PAPERCLIP_API_KEY not set");
  const res = await fetch(`${PAPERCLIP_API_URL}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${PAPERCLIP_API_KEY}`,
      "Origin": PAPERCLIP_API_URL,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} /api${path}: ${res.status} ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function resolveCompanyId(id?: string | null): string {
  const r = id?.trim() || PAPERCLIP_COMPANY_ID;
  if (!r) throw new Error("companyId required — PAPERCLIP_COMPANY_ID not set");
  return r;
}

export function resolveAgentId(id?: string | null): string {
  const r = id?.trim() || PAPERCLIP_AGENT_ID;
  if (!r) throw new Error("agentId required — PAPERCLIP_AGENT_ID not set");
  return r;
}

export function isConfigured(): boolean {
  return !!(PAPERCLIP_API_URL && PAPERCLIP_API_KEY);
}
