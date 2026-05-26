const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_ADMIN_EMAIL = process.env.PAPERCLIP_ADMIN_EMAIL || "";
const PAPERCLIP_ADMIN_PASS = process.env.PAPERCLIP_ADMIN_PASS || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";

interface Session {
  cookie: string;
  expiresAt: number;
}

let cached: Session | null = null;

async function authenticate(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.cookie;
  const res = await fetch(`${PAPERCLIP_API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: PAPERCLIP_API_URL },
    body: JSON.stringify({ email: PAPERCLIP_ADMIN_EMAIL, password: PAPERCLIP_ADMIN_PASS }),
  });
  if (!res.ok) throw new Error(`Paperclip auth failed: ${res.status}`);
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(/([^;]+)/);
  if (!match) throw new Error("No session cookie in auth response");
  cached = { cookie: match[1], expiresAt: Date.now() + 25 * 60 * 1000 };
  return cached.cookie;
}

export async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const cookie = await authenticate();
  const res = await fetch(`${PAPERCLIP_API_URL}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: PAPERCLIP_API_URL, Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  return !!(PAPERCLIP_API_URL && PAPERCLIP_ADMIN_EMAIL && PAPERCLIP_ADMIN_PASS);
}
