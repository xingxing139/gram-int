// GRAM 平台 · 主 API（Supabase Edge Function）
//
// 这一个函数即原 server.rb 的完整路由表。前端把 /api/xxx 请求改指向
// {SUPABASE_URL}/functions/v1/api/xxx，因此前端业务调用零改动。
//
// 会话与 CSRF 语义、错误码、字段名全部对齐原 Ruby 实现。

import {
  ApiError,
  handleOptions,
  jsonError,
  jsonOk,
  readJsonBody,
} from "../_shared/http.ts";
import {
  buildFilters,
  buildPage,
  callRpc,
  countRows,
  deleteRows,
  insertRow,
  pageMeta,
  selectOne,
  selectRows,
  updateRows,
  type Filter,
} from "../_shared/db.ts";
import {
  authenticate,
  clearSessionCookie,
  createSession,
  deleteSession,
  derivePassword,
  fairnessRoll,
  generateInvitationCode,
  integerParam,
  newSalt,
  requireAdmin,
  requireAdminOrAgent,
  requireLogin,
  validUsername,
  verifyPassword,
  writeAudit,
} from "../_shared/auth.ts";
import {
  adminDashboard,
  buildState,
  publicDepositAddresses,
  publicRound,
  publicUser,
  serializeAddress,
  serializeAdminHolding,
  serializeAdminRound,
  serializeAudit,
  serializeWalletEvent,
  serializeWalletRequest,
  giftCatalog,
} from "../_shared/business.ts";

// ---------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------
type Handler = (context: Context) => Promise<Response>;

interface Context {
  request: Request;
  route: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

interface RouteDefinition {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: RouteDefinition[] = [];

function register(method: string, pattern: string, handler: Handler): void {
  // 把 ":param" 占位符转换为「非斜杠片段」捕获组，例如 /api/users/:id → /api/users/([^/]+)
  const compiled = pattern.replace(/:([a-zA-Z]+)/g, "([^/]+)");
  routes.push({ method, pattern: new RegExp(`^${compiled}$`), handler });
}

// ---------------- 公开 / 认证 ----------------

register("GET", "/api/health", () =>
  jsonOk({ status: "ok", mode: "supabase", realAssets: true }, request);

register("POST", "/api/register", async ({ body }) => {
  const username = String(body["username"] ?? "").trim();
  const password = String(body["password"] ?? "");
  const normalized = username.toLowerCase();
  if (!validUsername(normalized)) throw new ApiError(422, "用户名需为 3–24 位字母、数字或 . _ -。");
  if (password.length < 8 || password.length > 128) throw new ApiError(422, "密码至少需要 8 位。");

  const code = String(body["invitationCode"] ?? "").trim();
  if (!code) throw new ApiError(422, "请填写邀请码后才能注册。");
  const inviter = await selectOne("users", [{ column: "invitation_code", operator: "eq", value: code.toUpperCase() }]);
  if (!inviter) throw new ApiError(422, "邀请码无效，请检查后重试。");
  if (String(inviter["status"]) !== "active") throw new ApiError(422, "邀请人账户已停用。");

  const existing = await selectOne("users", [{ column: "username", operator: "eq", value: normalized }], "id");
  if (existing) throw new ApiError(409, "这个用户名已注册。");

  const salt = newSalt();
  const hash = await derivePassword(password, salt);
  const ownCode = await generateInvitationCode();
  const created = await insertRow("users", {
    username: normalized,
    display_name: username.trim(),
    password_salt: salt,
    password_hash: hash,
    role: "user",
    invitation_code: ownCode,
    invited_by: Number(inviter["id"]),
    created_at: new Date().toISOString(),
  });
  const session = await createSession(Number(created["id"]));
  return jsonOk({ user: publicUser(created), csrfToken: session.csrf }, request, { "Set-Cookie": session.cookie });
});

register("POST", "/api/login", async ({ request, body }) => {
  const username = String(body["username"] ?? "").trim();
  const password = String(body["password"] ?? "");
  const user = await selectOne("users", [{ column: "username", operator: "eq", value: username.toLowerCase() }]);
  const valid = user && String(user["status"]) === "active" &&
    await verifyPassword(password, String(user["password_salt"]), String(user["password_hash"]));
  if (!valid) throw new ApiError(401, "用户名或密码不正确。");
  const session = await createSession(Number(user!["id"]));
  return jsonOk({ user: publicUser(user!), csrfToken: session.csrf }, request, { "Set-Cookie": session.cookie });
});

register("POST", "/api/logout", async ({ request }) => {
  const session = await authenticate(request);
  if (session) await deleteSession(session.token);
  return jsonOk({ ok: true }, request, { "Set-Cookie": clearSessionCookie() });
});

register("GET", "/api/session", async ({ request }) => {
  const session = await authenticate(request);
  if (!session) throw new ApiError(401, "请先登录。");
  return jsonOk({ user: publicUser(session.user), csrfToken: session.csrf }, request);
});

register("GET", "/api/state", async ({ request }) => {
  const session = await requireLogin(request);
  return jsonOk(await buildState(session), request);
});

register("GET", "/api/deposit-addresses", async ({ request }) => {
  await requireLogin(request);
  return jsonOk({ addresses: await publicDepositAddresses() }, request);
});

// ---------------- 铸造 / 钱包 / 典藏 ----------------

register("POST", "/api/rounds", async ({ request, body }) => {
  const session = await requireLogin(request);
  const level = integerParam(body["level"], "铸造池等级", 1, 8);
  const method = integerParam(body["method"], "铸造方式", 1, 2);
  const stake = integerParam(body["amountUnits"], "下注金额", 1, 2_000_000_000);

  const config = await selectOne("pool_configs", [{ column: "level", operator: "eq", value: level }]);
  if (!config || Number(config["enabled"]) !== 1) throw new ApiError(422, "该铸造池当前不可用。");
  if (stake < Number(config["minimum_units"])) throw new ApiError(422, "下注金额低于本池最低金额。");

  const active = await selectOne("rounds", [
    { column: "user_id", operator: "eq", value: session.user.id },
    { column: "level", operator: "eq", value: level },
    { column: "settled_at", operator: "is", value: null },
  ], "id");
  if (active) throw new ApiError(409, "该铸造池已有进行中的轮次。");

  const roundId = crypto.randomUUID();
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const commitment = await sha256(secret);
  const { nonce, draw } = await fairnessRoll(secret, roundId);
  const won = draw < Number(config["win_probability_bp"]);

  const result = await callRpc("place_round", {
    p_id: roundId,
    p_user_id: session.user.id,
    p_level: level,
    p_stake_units: stake,
    p_method: method,
    p_result: won ? 1 : 0,
    p_fairness_secret: secret,
    p_fairness_commitment: commitment,
    p_fairness_nonce: nonce,
    p_fairness_draw: draw,
    p_win_probability_bp: Number(config["win_probability_bp"]),
    p_profit_percent: Number(config["profit_percent"]),
  });

  const round = await selectOne("rounds", [{ column: "id", operator: "eq", value: roundId }]);
  return jsonOk({ round: publicRound(round!), ...result }, request);
});

register("POST", "/api/wallet/deposit", async ({ request, body }) => {
  const session = await requireLogin(request);
  const amount = integerParam(body["amountUnits"], "金额", 1, 2_000_000_000);
  const destination = String(body["address"] ?? "").trim();
  if (destination && destination.length > 200) throw new ApiError(422, "充值地址记录过长。");
  const requestId = crypto.randomUUID();
  await insertRow("wallet_requests", {
    id: requestId,
    user_id: session.user.id,
    kind: "deposit",
    amount_units: amount,
    address: destination || null,
    status: "pending",
    created_at: new Date().toISOString(),
  });
  return jsonOk({ requestId, state: await buildState(session) });
});

register("POST", "/api/wallet/withdraw", async ({ request, body }) => {
  const session = await requireLogin(request);
  const amount = integerParam(body["amountUnits"], "金额", 1, 2_000_000_000);
  const destination = String(body["address"] ?? "").trim();
  if (destination.length < 8 || destination.length > 128) throw new ApiError(422, "请填写有效的收款信息。");
  try {
    await callRpc("submit_withdraw", {
      p_request_id: crypto.randomUUID(),
      p_user_id: session.user.id,
      p_amount_units: amount,
      p_address: destination,
    });
  } catch (error) {
    throw mapRpcError(error);
  }
  return jsonOk({ state: await buildState(session) }, request);
});

register("POST", "/api/holdings", async ({ request, body }) => {
  const session = await requireLogin(request);
  const slug = String(body["slug"] ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,80}$/.test(slug)) throw new ApiError(422, "礼物编号无效。");
  const gift = await selectOne("gifts", [
    { column: "slug", operator: "eq", value: slug },
    { column: "active", operator: "eq", value: 1 },
  ], "slug");
  if (!gift) throw new ApiError(422, "该礼物不在可领取目录中。");
  const existing = await selectOne("holdings", [
    { column: "user_id", operator: "eq", value: session.user.id },
    { column: "slug", operator: "eq", value: slug },
  ], "id");
  if (existing) throw new ApiError(409, "你已经拥有该典藏品。");
  const holdingId = crypto.randomUUID();
  const created = await insertRow("holdings", {
    id: holdingId,
    user_id: session.user.id,
    slug,
    status: "owned",
    started_at: Math.floor(Date.now() / 1000),
    earned_units: 0,
  });
  return jsonOk({ holdingId, state: await buildState(session), holding: serializeAdminHolding(created) }, request);
});

register("PATCH", "/api/holdings/:id", async ({ request, route, body }) => {
  const session = await requireLogin(request);
  const holdingId = route.split("/")[3];
  const status = String(body["status"] ?? "");
  if (!["owned", "rental", "interest"].includes(status)) throw new ApiError(422, "典藏状态无效。");
  const holding = await selectOne("holdings", [{ column: "id", operator: "eq", value: holdingId }]);
  if (!holding || Number(holding["user_id"]) !== session.user.id) throw new ApiError(404, "典藏品不存在。");
  await updateRows("holdings", [{ column: "id", operator: "eq", value: holdingId }], { status });
  return jsonOk(await buildState(session), request);
});

register("POST", "/api/holdings/claim", async ({ request }) => {
  const session = await requireLogin(request);
  const claimed = await callRpc("claim_earnings", { p_user_id: session.user.id });
  const state = await buildState(session);
  return jsonOk({ ...state, claimedUnits: Number(claimed) }, request);
});

// ---------------- 管理后台：聚合数据 ----------------

register("GET", "/api/admin", async ({ request, query }) => {
  const session = await requireAdmin(request);
  return jsonOk(await adminDashboard(session, {
    page: Number(query.get("page")) || 1,
    agentPage: Number(query.get("agentPage")) || 1,
    roundsPage: Number(query.get("roundsPage")) || 1,
    holdingsPage: Number(query.get("holdingsPage")) || 1,
    walletPage: Number(query.get("walletPage")) || 1,
    auditPage: Number(query.get("auditPage")) || 1,
  }));
});

register("GET", "/api/agent", async ({ request, query }) => {
  const session = await requireAdminOrAgent(request);
  if (session.user.role !== "agent") throw new ApiError(403, "需要代理权限。");
  return jsonOk(await adminDashboard(session, {
    page: Number(query.get("page")) || 1,
    roundsPage: Number(query.get("roundsPage")) || 1,
    holdingsPage: Number(query.get("holdingsPage")) || 1,
    walletPage: Number(query.get("walletPage")) || 1,
  }));
});

register("GET", "/api/admin/list", async ({ request, query }) => {
  const session = await requireAdminOrAgent(request);
  const resource = query.get("resource") ?? "";
  const page = Number(query.get("page")) || 1;
  const filters = buildFilters({
    query: query.get("q") ?? "",
    status: query.get("status") ?? "",
    role: query.get("role") ?? "",
    kind: query.get("kind") ?? "",
  });

  const isAgent = session.user.role === "agent";
  const agentScope: Filter[] = isAgent
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${session.user.id})` }]
    : [];

  let table = "";
  let order = "id.desc";
  let extraFilters: Filter[] = [];
  let columns = "*";

  switch (resource) {
    case "users":
      if (isAgent) {
        // 代理只能看自己名下的普通用户
        extraFilters = [
          { column: "role", operator: "eq", value: "user" },
          { column: "invited_by", operator: "eq", value: session.user.id },
        ];
      }
      break;
    case "agents":
      if (isAgent) throw new ApiError(403, "只能查看自己名下的用户与订单数据。");
      extraFilters = [{ column: "role", operator: "eq", value: "agent" }];
      break;
    case "rounds":
    case "holdings":
    case "walletEvents":
    case "walletRequests":
      table = resource === "walletEvents" ? "wallet_events" : resource === "walletRequests" ? "wallet_requests" : resource;
      break;
    default:
      if (isAgent) throw new ApiError(403, "只能查看自己名下的用户与订单数据。");
      throw new ApiError(404, "数据资源不存在。");
  }

  if (resource === "users" || resource === "agents") table = "users";
  const statusFilter = query.get("status") ?? "";
  if (statusFilter === "flagged") extraFilters.push({ column: "risk_flag", operator: "eq", value: 1 });
  if (statusFilter === "clear") extraFilters.push({ column: "risk_flag", operator: "eq", value: 0 });
  if ((resource === "rounds" || resource === "holdings" || resource === "walletEvents" || resource === "walletRequests") && table === "rounds" && statusFilter !== "all" && statusFilter !== "" && statusFilter !== "flagged" && statusFilter !== "clear") {
    extraFilters.push({ column: "status", operator: "eq", value: statusFilter });
  }

  const combined = [...agentScope, ...filters, ...extraFilters];
  const total = await countRows(table, combined);
  const meta = pageMeta(total, page);
  const rows = await selectRows(table, combined, {
    order,
    limit: meta.perPage,
    offset: (meta.page - 1) * meta.perPage,
    columns,
  });

  // 序列化：补齐 username 等关联字段
  const needUserIds = new Set<number>();
  rows.forEach((row) => {
    if (row["user_id"] !== undefined) needUserIds.add(Number(row["user_id"]));
    if (row["admin_id"] !== undefined) needUserIds.add(Number(row["admin_id"]));
    if (row["resolved_by"] !== undefined && row["resolved_by"] !== null) needUserIds.add(Number(row["resolved_by"]));
  });
  const userMap = new Map<number, string>();
  if (needUserIds.size > 0) {
    const users = await selectRows("users", [
      { column: "id", operator: "in", value: `(${[...needUserIds].filter((id) => id > 0).join(",")})` },
    ], { columns: "id,username" });
    users.forEach((row) => userMap.set(Number(row["id"]), String(row["username"])));
  }

  let items: Record<string, unknown>[] = rows;
  if (resource === "users" || resource === "agents") {
    items = rows.map((row) => ({
      ...publicUser(row),
      status: String(row["status"]),
      balanceUnits: Number(row["balance_units"]),
      invitationCode: row["invitation_code"] ?? null,
      invitedBy: row["invited_by"] ?? null,
      createdAt: String(row["created_at"]),
    }));
  } else if (resource === "rounds") {
    items = rows.map((row) => serializeAdminRound({ ...row, username: userMap.get(Number(row["user_id"])) ?? "" }));
  } else if (resource === "holdings") {
    const catalog = new Map((await giftCatalog(true)).map((row) => [String(row["slug"]), row]));
    items = rows.map((row) => serializeAdminHolding({
      ...row,
      username: userMap.get(Number(row["user_id"])) ?? "",
      name: String(catalog.get(String(row["slug"]))?.["name"] ?? ""),
      english: String(catalog.get(String(row["slug"]))?.["english"] ?? ""),
    }));
  } else if (resource === "walletEvents") {
    items = rows.map((row) => serializeWalletEvent({ ...row, username: userMap.get(Number(row["user_id"])) ?? "" }));
  } else if (resource === "walletRequests") {
    items = rows.map((row) => serializeWalletRequest({
      ...row,
      username: userMap.get(Number(row["user_id"])) ?? "",
      resolved_by_username: row["resolved_by"] ? userMap.get(Number(row["resolved_by"])) ?? null : null,
    }));
  } else if (resource === "audit") {
    items = rows.map((row) => serializeAudit({ ...row, admin: userMap.get(Number(row["admin_id"])) ?? "" }));
  }

  return jsonOk(buildPage(items, meta), request);
});

// ---------------- 管理后台：用户 / 代理 ----------------

register("POST", "/api/admin/agents", async ({ request, body }) => {
  const session = await requireAdmin(request);
  const username = String(body["username"] ?? "").trim().toLowerCase();
  const password = String(body["password"] ?? "");
  if (!validUsername(username)) throw new ApiError(422, "代理用户名需为 3–24 位字母、数字或 . _ -。");
  if (password.length < 8 || password.length > 128) throw new ApiError(422, "代理登录密码至少需要 8 位。");
  const existing = await selectOne("users", [{ column: "username", operator: "eq", value: username }], "id");
  if (existing) throw new ApiError(409, "这个用户名已注册。");
  const salt = newSalt();
  const code = await generateInvitationCode();
  const created = await insertRow("users", {
    username,
    display_name: username,
    password_salt: salt,
    password_hash: await derivePassword(password, salt),
    role: "agent",
    invitation_code: code,
    invited_by: null,
    created_at: new Date().toISOString(),
  });
  await writeAudit(session.user.id, "agent_create", {
    userId: Number(created["id"]),
    username,
    invitationCode: code,
  });
  return jsonOk({ user: publicUser(created) }, request);
});

register("POST", "/api/admin/users", async ({ request, body }) => {
  const session = await requireAdmin(request);
  const username = String(body["username"] ?? "").trim().toLowerCase();
  const password = String(body["password"] ?? "");
  const displayName = String(body["displayName"] ?? "").trim() || username;
  const parentId = body["invitedBy"] === null || body["invitedBy"] === undefined || body["invitedBy"] === ""
    ? null
    : Number(body["invitedBy"]);

  if (!validUsername(username)) throw new ApiError(422, "用户名需为 3–24 位字母、数字或 . _ -。");
  if (password.length < 8 || password.length > 128) throw new ApiError(422, "登录密码至少需要 8 位。");
  const existing = await selectOne("users", [{ column: "username", operator: "eq", value: username }], "id");
  if (existing) throw new ApiError(409, "这个用户名已注册。");
  if (parentId !== null) {
    const parent = await selectOne("users", [{ column: "id", operator: "eq", value: parentId }], "id,role,status");
    if (!parent) throw new ApiError(404, "上级用户不存在。");
    if (!["agent", "admin"].includes(String(parent["role"]))) throw new ApiError(422, "上级用户必须是代理或管理员。");
    if (String(parent["status"]) !== "active") throw new ApiError(422, "上级账户已停用，暂不能登记用户。");
  }
  const salt = newSalt();
  const code = await generateInvitationCode();
  const created = await insertRow("users", {
    username,
    display_name: displayName,
    password_salt: salt,
    password_hash: await derivePassword(password, salt),
    role: "user",
    invitation_code: code,
    invited_by: parentId,
    created_at: new Date().toISOString(),
  });
  await writeAudit(session.user.id, "user_create", {
    userId: Number(created["id"]),
    username,
    invitationCode: code,
    invitedBy: parentId,
  });
  return jsonOk({ user: { ...publicUser(created), invitationCode: code } }, request);
});

register("PATCH", "/api/admin/users/:id", async ({ request, route, body }) => {
  const session = await requireAdminOrAgent(request);
  const userId = Number(route.split("/")[4]);
  const status = String(body["status"] ?? "");
  if (!["active", "suspended"].includes(status)) throw new ApiError(422, "用户状态无效。");
  const note = String(body["reason"] ?? "").trim();
  if (note.length < 3 || note.length > 200) throw new ApiError(422, "请填写 3–200 个字符的操作原因。");
  const user = await selectOne("users", [{ column: "id", operator: "eq", value: userId }]);
  if (!user) throw new ApiError(404, "用户不存在。");
  if (session.user.role === "agent") {
    if (Number(user["invited_by"]) !== session.user.id || String(user["role"]) !== "user") {
      throw new ApiError(403, "只能管理自己名下的普通用户。");
    }
  } else if (String(user["role"]) === "admin" && status === "suspended") {
    throw new ApiError(422, "不能停用最后一个管理员账户。");
  }
  await updateRows("users", [{ column: "id", operator: "eq", value: userId }], { status });
  await writeAudit(session.user.id, "user_status", { userId, status, reason: note });
  return jsonOk({ ok: true }, request);
});

register("PATCH", "/api/admin/users/:id/invitation", async ({ request, route }) => {
  const session = await requireAdmin(request);
  const userId = Number(route.split("/")[4]);
  const user = await selectOne("users", [{ column: "id", operator: "eq", value: userId }], "id");
  if (!user) throw new ApiError(404, "用户不存在。");
  const code = await generateInvitationCode();
  await updateRows("users", [{ column: "id", operator: "eq", value: userId }], { invitation_code: code });
  await writeAudit(session.user.id, "invitation_regenerate", { userId, newCode: code });
  return jsonOk({ invitationCode: code }, request);
});

register("PATCH", "/api/admin/users/:id/balance", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const userId = Number(route.split("/")[4]);
  const delta = Number(body["deltaUnits"]);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 2_000_000_000) {
    throw new ApiError(422, "请输入有效的调整金额。");
  }
  const note = String(body["reason"] ?? "").trim();
  if (note.length < 3 || note.length > 200) throw new ApiError(422, "请填写 3–200 个字符的操作原因。");
  const user = await selectOne("users", [{ column: "id", operator: "eq", value: userId }], "id");
  if (!user) throw new ApiError(404, "用户不存在。");
  try {
    const result = await callRpc("adjust_user_balance", {
      p_user_id: userId,
      p_delta_units: delta,
      p_reason: note,
    });
    await writeAudit(session.user.id, "balance_adjust", { userId, deltaUnits: delta, reason: note });
    return jsonOk({ ok: true, balanceUnits: Number(result) }, request);
  } catch (error) {
    throw mapRpcError(error);
  }
});

// ---------------- 管理后台：下注干预 / 风险 ----------------

register("PATCH", "/api/admin/rounds/:id/outcome", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const roundId = route.split("/")[4];
  const outcome = String(body["outcome"] ?? "");
  if (!["win", "lose", "reset"].includes(outcome)) {
    throw new ApiError(422, "干预结果无效，仅支持包赢、包输或恢复。");
  }
  const round = await selectOne("rounds", [{ column: "id", operator: "eq", value: roundId }]);
  if (!round) throw new ApiError(404, "下注记录不存在。");
  if (round["settled_at"] !== null) throw new ApiError(409, "该轮次已结算，无法干预结果。");

  if (outcome === "reset") {
    const natural = Number(round["fairness_draw"]) < Number(round["win_probability_bp"]) ? 1 : 0;
    await updateRows("rounds", [{ column: "id", operator: "eq", value: roundId }], {
      result: natural,
      forced_outcome: null,
    });
  } else {
    await updateRows("rounds", [{ column: "id", operator: "eq", value: roundId }], {
      result: outcome === "win" ? 1 : 0,
      forced_outcome: outcome,
    });
  }
  const reason = outcome === "win" ? "管理员设置为包赢" : outcome === "lose" ? "管理员设置为包输" : "管理员取消干预，恢复随机结果";
  await writeAudit(session.user.id, `round_force_${outcome}`, {
    roundId,
    userId: Number(round["user_id"]),
    forcedOutcome: outcome === "reset" ? null : outcome,
    reason,
  });
  return jsonOk({ ok: true }, request);
});

register("PATCH", "/api/admin/rounds/:id/risk", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const roundId = route.split("/")[4];
  const flagged = body["flagged"];
  if (typeof flagged !== "boolean") throw new ApiError(422, "请明确设置风险标记状态。");
  const round = await selectOne("rounds", [{ column: "id", operator: "eq", value: roundId }], "id,user_id");
  if (!round) throw new ApiError(404, "下注记录不存在。");
  const note = String(body["reason"] ?? "").trim();
  if (flagged && (note.length < 3 || note.length > 200)) {
    throw new ApiError(422, "请填写 3–200 个字符的风险审核原因。");
  }
  await updateRows("rounds", [{ column: "id", operator: "eq", value: roundId }], {
    risk_flag: flagged ? 1 : 0,
    risk_note: flagged ? note : null,
  });
  await writeAudit(session.user.id, "round_risk_flag", {
    roundId,
    userId: Number(round["user_id"]),
    flagged,
    reason: flagged ? note : "管理员清除风险标记",
  });
  return jsonOk({ ok: true }, request);
});

// ---------------- 管理后台：钱包 / 池 / 礼物 / 典藏 ----------------

register("PATCH", "/api/admin/wallet-requests/:id", async ({ request, route, body }) => {
  const session = await requireAdminOrAgent(request);
  const requestId = route.split("/")[4];
  const decision = String(body["decision"] ?? "");
  const note = String(body["reason"] ?? "").trim();
  if (!["approve", "cancel"].includes(decision)) throw new ApiError(422, "审核操作无效。");
  if (note.length < 3 || note.length > 200) throw new ApiError(422, "请填写 3–200 个字符的审核备注。");
  const request = await selectOne("wallet_requests", [{ column: "id", operator: "eq", value: requestId }]);
  if (!request) throw new ApiError(404, "资金申请不存在。");
  if (String(request["status"]) !== "pending") throw new ApiError(409, "该申请已处理，不能重复审核。");
  if (session.user.role === "agent") {
    const owner = await selectOne("users", [
      { column: "id", operator: "eq", value: Number(request["user_id"]) },
    ], "role,invited_by");
    if (!owner || String(owner["role"]) !== "user" || Number(owner["invited_by"]) !== session.user.id) {
      throw new ApiError(403, "只能审核自己名下用户的申请。");
    }
  }
  try {
    const status = await callRpc("resolve_wallet_request", {
      p_request_id: requestId,
      p_admin_id: session.user.id,
      p_decision: decision,
      p_reason: note,
    });
    await writeAudit(session.user.id, `wallet_request_${decision}`, {
      requestId,
      userId: Number(request["user_id"]),
      kind: String(request["kind"]),
      amountUnits: Number(request["amount_units"]),
      reason: note,
    });
    return jsonOk({ ok: true, status }, request);
  } catch (error) {
    throw mapRpcError(error);
  }
});

register("PATCH", "/api/admin/pools/:level", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const level = integerParam(route.split("/")[4], "铸造池等级", 1, 8);
  const config = await selectOne("pool_configs", [{ column: "level", operator: "eq", value: level }]);
  if (!config) throw new ApiError(404, "铸造池不存在。");
  const probability = integerParam(body["winProbabilityBp"], "公开胜率", 0, 10_000);
  const profit = integerParam(body["profitPercent"], "收益率", 0, 500);
  const minimum = integerParam(body["minimumUnits"] ?? config["minimum_units"], "最低下注金额", 1, 2_000_000_000);
  const entry = integerParam(body["entryUnits"] ?? config["entry_units"], "账户门槛", 1, 2_000_000_000);
  const duration = integerParam(body["durationSeconds"] ?? config["duration_seconds"], "倒计时秒数", 1, 86_400);
  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") throw new ApiError(422, "铸造池状态无效。");
  await updateRows("pool_configs", [{ column: "level", operator: "eq", value: level }], {
    minimum_units: minimum,
    entry_units: entry,
    duration_seconds: duration,
    win_probability_bp: probability,
    profit_percent: profit,
    enabled: enabled ? 1 : 0,
  });
  await writeAudit(session.user.id, "pool_config", {
    level, minimumUnits: minimum, entryUnits: entry, durationSeconds: duration,
    winProbabilityBp: probability, profitPercent: profit, enabled,
  });
  return jsonOk({ ok: true }, request);
});

register("PUT", "/api/admin/gifts/:slug", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const slug = route.split("/")[4];
  if (!/^[a-zA-Z0-9-]{2,80}$/.test(slug)) throw new ApiError(422, "礼物编号无效。");
  const name = String(body["name"] ?? "").trim();
  const english = String(body["english"] ?? "").trim();
  const category = String(body["category"] ?? "").trim();
  if ([name, english, category].some((value) => value.length === 0)) {
    throw new ApiError(422, "礼物名称、英文名和分类均为必填项。");
  }
  if ([name, english, category].some((value) => value.length > 80)) throw new ApiError(422, "礼物字段过长。");
  const existing = await selectOne("gifts", [{ column: "slug", operator: "eq", value: slug }], "slug");
  if (existing) {
    await updateRows("gifts", [{ column: "slug", operator: "eq", value: slug }], { name, english, category });
  } else {
    await insertRow("gifts", { slug, name, english, category, active: 1 });
  }
  await writeAudit(session.user.id, "gift_upsert", { slug, name, english, category });
  return jsonOk({ ok: true }, request);
});

register("PATCH", "/api/admin/gifts/:slug/status", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const slug = route.split("/")[4];
  const active = body["active"];
  if (typeof active !== "boolean") throw new ApiError(422, "请明确设置上架状态。");
  const gift = await selectOne("gifts", [{ column: "slug", operator: "eq", value: slug }], "slug");
  if (!gift) throw new ApiError(404, "礼物不存在。");
  await updateRows("gifts", [{ column: "slug", operator: "eq", value: slug }], { active: active ? 1 : 0 });
  await writeAudit(session.user.id, "gift_status", { slug, active });
  return jsonOk({ ok: true }, request);
});

register("DELETE", "/api/admin/holdings/:id", async ({ request, route }) => {
  const session = await requireAdmin(request);
  const holdingId = route.split("/")[4];
  const holding = await selectOne("holdings", [{ column: "id", operator: "eq", value: holdingId }], "id,user_id,slug");
  if (!holding) throw new ApiError(404, "典藏品不存在。");
  await deleteRows("holdings", [{ column: "id", operator: "eq", value: holdingId }]);
  await writeAudit(session.user.id, "holding_remove", {
    userId: Number(holding["user_id"]),
    holdingId,
    slug: String(holding["slug"]),
  });
  return jsonOk({ ok: true }, request);
});

// ---------------- 管理后台：充值地址 ----------------

register("GET", "/api/admin/deposit-addresses", async ({ request }) => {
  await requireAdmin(request);
  const rows = await selectRows("deposit_addresses", [], { order: "sort_order.asc,id.asc" });
  return jsonOk({ addresses: rows.map((row) => serializeAddress(row, true)) }, request);
});

register("POST", "/api/admin/deposit-addresses", async ({ request, body }) => {
  const session = await requireAdmin(request);
  const label = String(body["label"] ?? "").trim();
  const address = String(body["address"] ?? "").trim();
  const note = String(body["note"] ?? "").trim();
  if (label.length < 1 || label.length > 40) throw new ApiError(422, "请填写地址名称（1–40 个字符）。");
  if (address.length < 4 || address.length > 160) throw new ApiError(422, "请填写充值地址（4–160 个字符）。");
  if (/\s/.test(address)) throw new ApiError(422, "充值地址不能包含空格或换行。");
  if (note.length > 200) throw new ApiError(422, "备注不能超过 200 个字符。");
  const active = body["active"] === false ? 0 : 1;
  const nextOrder = await selectRows("deposit_addresses", [], { columns: "sort_order", order: "sort_order.desc", limit: 1 })
    .then((rows) => (rows.length > 0 ? Number(rows[0]["sort_order"]) + 1 : 1));
  const created = await insertRow("deposit_addresses", {
    label, address, note, active, sort_order: nextOrder,
    created_at: new Date().toISOString(),
  });
  await writeAudit(session.user.id, "deposit_address_create", {
    id: Number(created["id"]), label, address, active: active === 1,
  });
  return jsonOk({ address: { ...serializeAddress(created, true) } }, request);
});

register("PATCH", "/api/admin/deposit-addresses/:id", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const id = Number(route.split("/")[4]);
  const record = await selectOne("deposit_addresses", [{ column: "id", operator: "eq", value: id }]);
  if (!record) throw new ApiError(404, "充值地址不存在。");
  const label = String(body["label"] ?? record["label"] ?? "").trim();
  const address = String(body["address"] ?? record["address"] ?? "").trim();
  const note = String(body["note"] ?? record["note"] ?? "").trim();
  const active = body["active"] === undefined ? Number(record["active"]) : (body["active"] ? 1 : 0);
  if (label.length < 1 || label.length > 40) throw new ApiError(422, "请填写地址名称（1–40 个字符）。");
  if (address.length < 4 || address.length > 160) throw new ApiError(422, "请填写充值地址（4–160 个字符）。");
  if (/\s/.test(address)) throw new ApiError(422, "充值地址不能包含空格或换行。");
  if (note.length > 200) throw new ApiError(422, "备注不能超过 200 个字符。");
  await updateRows("deposit_addresses", [{ column: "id", operator: "eq", value: id }], {
    label, address, note, active,
  });
  await writeAudit(session.user.id, "deposit_address_update", { id, label, address, active: active === 1 });
  const updated = await selectOne("deposit_addresses", [{ column: "id", operator: "eq", value: id }]);
  return jsonOk({ address: serializeAddress(updated, true) }, request);
});

register("PATCH", "/api/admin/deposit-addresses/:id/status", async ({ request, route, body }) => {
  const session = await requireAdmin(request);
  const id = Number(route.split("/")[4]);
  const active = body["active"];
  if (typeof active !== "boolean") throw new ApiError(422, "请明确设置启用状态。");
  const record = await selectOne("deposit_addresses", [{ column: "id", operator: "eq", value: id }], "id");
  if (!record) throw new ApiError(404, "充值地址不存在。");
  await updateRows("deposit_addresses", [{ column: "id", operator: "eq", value: id }], { active: active ? 1 : 0 });
  await writeAudit(session.user.id, "deposit_address_status", { id, active });
  return jsonOk({ ok: true }, request);
});

register("DELETE", "/api/admin/deposit-addresses/:id", async ({ request, route }) => {
  const session = await requireAdmin(request);
  const id = Number(route.split("/")[4]);
  const record = await selectOne("deposit_addresses", [{ column: "id", operator: "eq", value: id }], "id,label,address");
  if (!record) throw new ApiError(404, "充值地址不存在。");
  await deleteRows("deposit_addresses", [{ column: "id", operator: "eq", value: id }]);
  await writeAudit(session.user.id, "deposit_address_delete", {
    id, label: String(record["label"]), address: String(record["address"]),
  });
  return jsonOk({ ok: true }, request);
});

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapRpcError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("INSUFFICIENT_BALANCE")) return new ApiError(422, "可用余额不足。");
  if (message.includes("NEGATIVE_BALANCE")) return new ApiError(422, "调整后余额不能为负。");
  if (message.includes("BALANCE_OVERFLOW")) return new ApiError(422, "调整后余额超出范围。");
  if (message.includes("USER_NOT_FOUND")) return new ApiError(404, "用户不存在。");
  if (message.includes("REQUEST_NOT_FOUND")) return new ApiError(404, "资金申请不存在。");
  if (message.includes("ALREADY_RESOLVED")) return new ApiError(409, "该申请已处理，不能重复审核。");
  if (message.includes("STAKE_BELOW_MINIMUM")) return new ApiError(422, "下注金额低于本池最低金额。");
  if (message.includes("ENTRY_THRESHOLD")) return new ApiError(403, "账户总额未达到本池门槛。");
  if (message.includes("ROUND_ACTIVE")) return new ApiError(409, "该铸造池已有进行中的轮次。");
  if (message.includes("POOL_UNAVAILABLE")) return new ApiError(422, "该铸造池当前不可用。");
  if (message.startsWith("23")) return new ApiError(409, "数据冲突，请刷新后重试。");
  return new ApiError(422, message || "操作失败，请稍后重试。");
}

function routePath(url: string): string {
  const { pathname } = new URL(url);
  const marker = "/functions/v1/api";
  const index = pathname.indexOf(marker);
  if (index === -1) return pathname;
  return pathname.slice(index + marker.length) || "/";
}

// ---------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------
Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;

  const url = new URL(request.url);
  const route = routePath(request.url);
  const query = url.searchParams;

  try {
    const body = await readJsonBody(request);
    const match = routes.find((entry) => entry.method === request.method && entry.pattern.test(route));
    if (!match) {
      // 兼容把整段路径当作一个参数传递的调用方
      const fallback = routes.find((entry) => {
        if (entry.method !== request.method) return false;
        const tokens = entry.pattern.source.replace(/^\^|\$$/g, "").split("/");
        const parts = route.split("/");
        if (tokens.length !== parts.length) return false;
        return tokens.every((token, index) => token.startsWith(":") || token === parts[index]);
      });
      if (!fallback) return jsonError(404, "接口不存在。", request);
      return await fallback.handler({ request, route, body, query });
    }
    return await match.handler({ request, route, body, query });
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error.status, error.message, request);
    console.error("[gram] 未处理异常:", error);
    return jsonError(500, "服务暂时无法处理请求。", request);
  }
});
