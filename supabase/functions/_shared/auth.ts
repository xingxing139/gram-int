// Edge Functions 共享库：认证、会话、CSRF、密码派生、公开随机承诺
// 对应原 server.rb 的 authenticate / issue_session / require_admin / fairness_roll 等逻辑

import {
  ApiError,
  constantTimeEquals,
  parseCookies,
  randomHex,
} from "./http.ts";
import { selectOne, selectRows, updateRows, deleteRows, type Row } from "./db.ts";

const PBKDF2_ITERATIONS = 120_000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function newSalt(): string {
  return randomHex(16);
}

export async function derivePassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = await derivePassword(password, saltHex);
  return constantTimeEquals(actual, expectedHash);
}

// 会话令牌只存哈希，库里不落明文
export async function sessionDigest(token: string): Promise<string> {
  return sha256Hex(`session:${token}`);
}

export async function createSession(userId: number): Promise<{ token: string; csrf: string; cookie: string }> {
  const token = crypto.randomUUID().replace(/-/g, "") + randomHex(16);
  const csrf = randomHex(24);
  const digest = await sessionDigest(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  insertRow("sessions", {
    token_digest: digest,
    csrf_token: csrf,
    user_id: userId,
    expires_at: expiresAt,
  });

  // 前端通常托管在另一个域名（GitHub Pages / Cloudflare Pages），属于跨站请求。
  // 跨站 Cookie 必须 SameSite=None 且 Secure，否则浏览器既不存储也不发送；
  // Supabase 函数始终通过 HTTPS 提供，因此可以无条件下发 Secure。
  // 若将本函数与前端部署在同源环境下，可设 GRAM_SAME_SITE_COOKIES=1 退回 Lax。
  const sameSite = Deno.env.get("GRAM_SAME_SITE_COOKIES") === "1" ? "Lax" : "None";
  const cookie = [
    `gram_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "Secure",
  ].join("; ");
  return { token, csrf, cookie };
}

export function clearSessionCookie(): string {
  const sameSite = Deno.env.get("GRAM_SAME_SITE_COOKIES") === "1" ? "Lax" : "None";
  return [
    "gram_session=",
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
    "Secure",
  ].join("; ");
}

export async function deleteSession(token: string): Promise<void> {
  const digest = await sessionDigest(token);
  await deleteRows("sessions", [{ column: "token_digest", operator: "eq", value: digest }]);
}

export interface AuthenticatedUser extends Row {
  id: number;
  username: string;
  display_name: string;
  role: string;
  status: string;
  balance_units: number;
  invitation_code: string | null;
  invited_by: number | null;
}

export interface SessionContext {
  user: AuthenticatedUser;
  csrf: string;
  token: string;
}

const STRONG_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);

// 读取并校验会话；写操作同时校验 CSRF
export async function authenticate(request: Request): Promise<SessionContext | null> {
  const jar = parseCookies(request);
  const token = jar["gram_session"];
  if (!token) return null;

  const digest = await sessionDigest(token);
  const row = await selectOne("sessions", [{ column: "token_digest", operator: "eq", value: digest }]);
  if (!row) return null;
  if (Number(row["expires_at"]) * 1000 < Date.now()) {
    await deleteRows("sessions", [{ column: "token_digest", operator: "eq", value: digest }]);
    return null;
  }

  const csrf = String(row["csrf_token"]);
  if (STRONG_METHODS.has(request.method)) {
    const supplied = request.headers.get("X-CSRF-Token") ?? "";
    if (!supplied || !constantTimeEquals(supplied, csrf)) {
      throw new ApiError(403, "请求校验已过期，请刷新页面后重试。");
    }
  }

  const user = await selectOne("users", [{ column: "id", operator: "eq", value: row["user_id"] }]);
  if (!user) return null;
  return { user: user as AuthenticatedUser, csrf, token };
}

export async function requireLogin(request: Request): Promise<SessionContext> {
  const session = await authenticate(request);
  if (!session) throw new ApiError(401, "请先登录。");
  if (session.user.status !== "active") throw new ApiError(403, "该账户已停用。");
  return session;
}

export async function requireAdmin(request: Request): Promise<SessionContext> {
  const session = await requireLogin(request);
  if (session.user.role !== "admin") throw new ApiError(403, "需要管理员权限。");
  return session;
}

export async function requireAdminOrAgent(request: Request): Promise<SessionContext> {
  const session = await requireLogin(request);
  if (!["admin", "agent"].includes(session.user.role)) {
    throw new ApiError(403, "需要管理员或代理权限。");
  }
  return session;
}

// 公开随机承诺：nonce 与抽样值由 SHA-256(secret:roundId) 派生，
// 与原 Ruby 版 fairness_roll 的语义一致
export async function fairnessRoll(secretHex: string, roundId: string): Promise<{ nonce: number; draw: number }> {
  const digest = await sha256Hex(`${secretHex}:${roundId}`);
  return {
    nonce: parseInt(digest.slice(0, 8), 16) % 1_000_000,
    draw: parseInt(digest.slice(32, 36), 16) % 10_000,
  };
}

export function validUsername(value: string): boolean {
  return /^[a-zA-Z0-9._-]{3,24}$/.test(value);
}

export function integerParam(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, `${label}无效，请检查后重试。`);
  }
  return parsed;
}

export const INVITATION_ALPHABET = [
  ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)),
  ...Array.from({ length: 10 }, (_, index) => String(index)),
];

export async function generateInvitationCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      code += INVITATION_ALPHABET[Math.floor(Math.random() * INVITATION_ALPHABET.length)];
    }
    const existing = await selectOne("users", [{ column: "invitation_code", operator: "eq", value: code }], "id");
    if (!existing) return code;
  }
  throw new ApiError(503, "邀请码生成拥挤，请稍后重试。");
}

export async function writeAudit(adminId: number, action: string, detail: unknown): Promise<void> {
  insertRow("admin_audit", {
    admin_id: adminId,
    action,
    detail_json: JSON.stringify(detail),
    created_at: new Date().toISOString(),
  });
}

export async function touchSessionKeepAlive(token: string): Promise<void> {
  const digest = await sessionDigest(token);
  await updateRows(
    "sessions",
    [{ column: "token_digest", operator: "eq", value: digest }],
    { expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
  );
}

export async function listUserSessions(userId: number): Promise<Row[]> {
  return selectRows("sessions", [{ column: "user_id", operator: "eq", value: userId }]);
}
