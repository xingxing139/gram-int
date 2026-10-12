// Edge Functions 共享库：PostgreSQL 数据访问
// 通过 Supabase REST 接口以 service_role 身份访问（绕过 RLS）。
//
// 原 Ruby 版用 database.transaction 包裹「读余额 → 扣款 → 写记录」等复合操作；
// PostgREST 没有多语句事务，这里用 Postgres 函数（RPC）保证原子性，
// 因此 money/round 相关写入都走 callRpc，而不是多次 REST 调用。
//
// 同时保留一个「租约式」串行化：所有会改余额的 RPC 都在数据库侧
// SELECT ... FOR UPDATE，天然避免并发超额下注。

import { ApiError } from "./http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn("[gram] 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，请在 Edge Function 环境变量中配置");
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function encodeTablePath(table: string, query = ""): string {
  return `${SUPABASE_URL}/rest/v1/${table}${query}`;
}

async function restFetch(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: restHeaders(init.headers as Record<string, string>) });
  const text = await response.text();
  if (!response.ok) {
    // 23505 unique / 23514 check / 23503 fk → 对应的业务冲突
    let code = "";
    try {
      code = (JSON.parse(text) as { code?: string }).code ?? "";
    } catch { /* 非 JSON 响应 */ }
    if (code.startsWith("23")) throw new ApiError(409, "数据冲突，请刷新后重试。");
    throw new ApiError(502, `数据库请求失败（${response.status}）。`);
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- 查询构造 ----------
export interface Filter {
  column: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is";
  value: unknown;
}

function buildQuery(filters: Filter[] = []): string {
  if (filters.length === 0) return "";
  const params = filters.map((filter) => {
    const value = typeof filter.value === "number" || typeof filter.value === "boolean"
      ? String(filter.value)
      : String(filter.value);
    return `${filter.column}=${filter.operator}.${encodeURIComponent(value)}`;
  });
  return `?${params.join("&")}`;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export async function selectRows(
  table: string,
  filters: Filter[] = [],
  options: { order?: string; limit?: number; offset?: number; columns?: string } = {},
): Promise<Row[]> {
  const params = new URLSearchParams();
  for (const filter of filters) {
    const value = typeof filter.value === "number" || typeof filter.value === "boolean"
      ? String(filter.value)
      : String(filter.value);
    params.append(filter.column, `${filter.operator}.${value}`);
  }
  if (options.order) params.set("order", options.order);
  if (typeof options.limit === "number") params.set("limit", String(options.limit));
  if (typeof options.offset === "number") params.set("offset", String(options.offset));
  params.set("select", options.columns ?? "*");
  const query = `?${params.toString()}`;
  const rows = await restFetch(encodeTablePath(table, query), { method: "GET" });
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

export async function selectOne(table: string, filters: Filter[], columns = "*"): Promise<Row | null> {
  const params = new URLSearchParams();
  for (const filter of filters) {
    const value = typeof filter.value === "number" || typeof filter.value === "boolean"
      ? String(filter.value)
      : String(filter.value);
    params.append(filter.column, `${filter.operator}.${value}`);
  }
  params.set("select", columns);
  params.set("limit", "1");
  const rows = await restFetch(encodeTablePath(table, `?${params.toString()}`), { method: "GET" });
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as Row) : null;
}

export async function countRows(table: string, filters: Filter[] = []): Promise<number> {
  const params = new URLSearchParams();
  for (const filter of filters) {
    const value = typeof filter.value === "number" || typeof filter.value === "boolean"
      ? String(filter.value)
      : String(filter.value);
    params.append(filter.column, `${filter.operator}.${value}`);
  }
  params.set("select", "*");
  const response = await fetch(encodeTablePath(table, `?${params.toString()}`), {
    method: "HEAD",
    headers: { ...restHeaders(), Prefer: "count=exact" },
  });
  const range = response.headers.get("Content-Range") ?? "";
  const total = range.split("/")[1];
  return total ? Number(total) : 0;
}

// ---------- 写入 ----------
export async function insertRow(table: string, values: Row): Promise<Row> {
  const rows = await restFetch(encodeTablePath(table, ""), {
    method: "POST",
    body: JSON.stringify(values),
    headers: { Prefer: "return=representation" },
  });
  const list = Array.isArray(rows) ? (rows as Row[]) : [];
  if (list.length === 0) throw new ApiError(502, "写入失败。");
  return list[0];
}

export async function updateRows(table: string, filters: Filter[], values: Row): Promise<Row[]> {
  const query = buildQuery(filters);
  const rows = await restFetch(encodeTablePath(table, query), {
    method: "PATCH",
    body: JSON.stringify(values),
    headers: { Prefer: "return=representation" },
  });
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

export async function deleteRows(table: string, filters: Filter[]): Promise<void> {
  await restFetch(encodeTablePath(table, buildQuery(filters)), { method: "DELETE" });
}

// ---------- RPC（Postgres 函数，保证原子性） ----------
export async function callRpc(name: string, args: Row): Promise<Row> {
  const result = await restFetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(args),
    headers: { Prefer: "return=representation" },
  });
  return (result ?? {}) as Row;
}

// ---------- 分页元数据 ----------
export interface PageMeta {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
}

export const ADMIN_PAGE_SIZE = 10;

export function pageMeta(total: number, pageRaw: unknown, perPage = ADMIN_PAGE_SIZE): PageMeta {
  const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / perPage));
  let page = Number(pageRaw);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  return { page, totalPages, total, perPage };
}

export function buildPage<T>(items: T[], meta: PageMeta): { items: T[] } & PageMeta {
  return { items, ...meta };
}

export function buildFilters(options: {
  query?: string;
  queryColumns?: string[];
  status?: string;
  role?: string;
  kind?: string;
}): Filter[] {
  const filters: Filter[] = [];
  const query = (options.query ?? "").trim().toLowerCase();
  if (query && options.queryColumns && options.queryColumns.length > 0) {
    // PostgREST 的 or=(...) 语法：多个 ilike 以逗号分隔
    const conditions = options.queryColumns
      .map((column) => `${column}.ilike.*${query}*`)
      .join(",");
    filters.push({ column: "or", operator: "eq", value: `(${conditions})` });
  }
  if (options.status && options.status !== "all" && options.status !== "flagged" && options.status !== "clear") {
    filters.push({ column: "status", operator: "eq", value: options.status });
  }
  if (options.role && options.role !== "all") {
    filters.push({ column: "role", operator: "eq", value: options.role });
  }
  if (options.kind && options.kind !== "all") {
    filters.push({ column: "kind", operator: "eq", value: options.kind });
  }
  return filters;
}
