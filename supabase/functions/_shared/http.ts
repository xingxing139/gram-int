// Edge Functions 共享库：错误类型、JSON 响应、CORS
// 对应原 server.rb 的 ApiError / json_error / respond_with

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

// CORS：当前端用 credentials: "include" 跨站携带 Cookie 时，规范禁止
# Access-Control-Allow-Origin: *，必须回显具体 Origin 并显式声明允许凭证。
function corsHeaders(request: Request | null): Record<string, string> {
  const origin = request?.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function buildHeaders(base: Record<string, string>, request: Request | null = null): Record<string, string> {
  return { ...base, ...corsHeaders(request) };
}

export function jsonOk(body: unknown, request: Request | null = null, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? { ok: true }), {
    status: 200,
    headers: buildHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    }, request),
  });
}

export function jsonError(status: number, message: string, request: Request | null = null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: buildHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }, request),
  });
}

export function handleOptions(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const raw = await request.text();
  if (!raw.trim()) return {};
  if (raw.length > 32_768) throw new ApiError(413, "请求内容过大。");
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "请求内容必须是 JSON 对象。");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "请求内容不是有效 JSON。");
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie") ?? "";
  const jar: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    jar[name] = decodeURIComponent(rest.join("="));
  }
  return jar;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attributes = [
    `gram_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (Deno.env.get("GRAM_SECURE_COOKIES") === "1") attributes.push("Secure");
  return attributes.join("; ");
}

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomUuid(): string {
  return crypto.randomUUID();
}
