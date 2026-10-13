// Edge Functions 共享库：业务序列化与聚合查询
// 对应原 server.rb 的 public_user / public_round / state / admin_dashboard 等

import {
  ADMIN_PAGE_SIZE,
  buildPage,
  countRows,
  pageMeta,
  selectOne,
  selectRows,
  type Filter,
  type Row,
} from "./db.ts";
import { fairnessRoll, type SessionContext } from "./auth.ts";

const KINDS_ALLOWED = [
  "deposit", "withdraw", "mint-win", "mint-loss",
  "admin-credit", "admin-debit", "withdraw-release", "collectible-reward",
];

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function publicUser(row: Row): Record<string, unknown> {
  return {
    id: num(row["id"]),
    username: String(row["username"] ?? ""),
    displayName: String(row["display_name"] ?? ""),
    role: String(row["role"] ?? "user"),
    balanceUnits: num(row["balance_units"]),
    invitationCode: row["invitation_code"] ?? null,
    invitedBy: row["invited_by"] === null || row["invited_by"] === undefined
      ? null
      : num(row["invited_by"]),
  };
}

export function publicRound(row: Row): Record<string, unknown> {
  const settled = row["settled_at"] !== null && row["settled_at"] !== undefined;
  return {
    id: String(row["id"] ?? ""),
    level: num(row["level"]),
    betAmount: num(row["stake_units"]),
    profitAmount: settled ? num(row["profit_units"]) : null,
    method: num(row["method"]),
    won: settled ? num(row["result"]) === 1 : null,
    startedAt: num(row["started_at"]) * 1000,
    endsAt: settled ? 0 : num(row["ends_at"]) * 1000,
    settled,
    completed: settled,
    winProbabilityBp: num(row["win_probability_bp"]),
    profitPercent: num(row["profit_percent"]),
    fairnessCommitment: String(row["fairness_commitment"] ?? ""),
    fairnessSecret: settled ? String(row["fairness_secret"] ?? "") : null,
    fairnessNonce: num(row["fairness_nonce"]),
    fairnessDraw: settled ? num(row["fairness_draw"]) : null,
  };
}

export function serializeHolding(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"] ?? ""),
    slug: String(row["slug"] ?? ""),
    status: String(row["status"] ?? "owned"),
    startedAt: num(row["started_at"]) * 1000,
    earnedUnits: num(row["earned_units"]),
    itemName: row["name"] ?? null,
    english: row["english"] ?? null,
  };
}

export function serializeAdminHolding(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"] ?? ""),
    userId: num(row["user_id"]),
    username: String(row["username"] ?? ""),
    slug: String(row["slug"] ?? ""),
    name: String(row["name"] ?? ""),
    english: String(row["english"] ?? ""),
    status: String(row["status"] ?? "owned"),
    startedAt: num(row["started_at"]) * 1000,
  };
}

export function serializeAdminRound(row: Row): Record<string, unknown> {
  const settled = row["settled_at"] !== null && row["settled_at"] !== undefined;
  return {
    id: String(row["id"] ?? ""),
    userId: num(row["user_id"]),
    username: String(row["username"] ?? ""),
    level: num(row["level"]),
    betAmount: num(row["stake_units"]),
    profitAmount: num(row["profit_units"]),
    won: settled ? num(row["result"]) === 1 : null,
    winProbabilityBp: num(row["win_probability_bp"]),
    profitPercent: num(row["profit_percent"]),
    startedAt: num(row["started_at"]) * 1000,
    endsAt: num(row["ends_at"]) * 1000,
    settled,
    fairnessCommitment: String(row["fairness_commitment"] ?? ""),
    riskFlag: num(row["risk_flag"]) === 1,
    riskNote: row["risk_note"] ?? null,
    forcedOutcome: row["forced_outcome"] ?? null,
  };
}

export function serializeWalletEvent(row: Row): Record<string, unknown> {
  return {
    id: num(row["id"]),
    userId: num(row["user_id"]),
    username: String(row["username"] ?? ""),
    kind: String(row["kind"] ?? ""),
    amountUnits: num(row["amount_units"]),
    createdAt: String(row["created_at"] ?? ""),
  };
}

export function serializeWalletRequest(row: Row): Record<string, unknown> {
  return {
    id: String(row["id"] ?? ""),
    userId: num(row["user_id"]),
    username: String(row["username"] ?? ""),
    kind: String(row["kind"] ?? ""),
    amountUnits: num(row["amount_units"]),
    address: row["address"] ?? null,
    status: String(row["status"] ?? "pending"),
    createdAt: String(row["created_at"] ?? ""),
    resolvedAt: row["resolved_at"] ?? null,
    resolutionNote: row["resolution_note"] ?? null,
    resolvedBy: row["resolved_by_username"] ?? null,
  };
}

export function serializeAudit(row: Row): Record<string, unknown> {
  let detail: unknown = {};
  try {
    detail = JSON.parse(String(row["detail_json"] ?? "{}"));
  } catch {
    detail = {};
  }
  return {
    id: num(row["id"]),
    admin: String(row["admin"] ?? ""),
    action: String(row["action"] ?? ""),
    detail,
    createdAt: String(row["created_at"] ?? ""),
  };
}

export function serializeAddress(row: Row, includeTimestamps = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: num(row["id"]),
    label: String(row["label"] ?? ""),
    address: String(row["address"] ?? ""),
    note: String(row["note"] ?? ""),
  };
  if (includeTimestamps) {
    base.active = num(row["active"]) === 1;
    base.sortOrder = num(row["sort_order"]);
    base.createdAt = String(row["created_at"] ?? "");
  }
  return base;
}

export async function poolRules(): Promise<Row[]> {
  return selectRows("pool_configs", [], {
    order: "level.asc",
    columns: "level,name,minimum_units,entry_units,duration_seconds,profit_percent,win_probability_bp,enabled",
  });
}

export async function giftCatalog(includeInactive = false): Promise<Row[]> {
  const filters: Filter[] = includeInactive ? [] : [{ column: "active", operator: "eq", value: 1 }];
  return selectRows("gifts", filters, { order: "slug.asc" });
}

export async function publicDepositAddresses(): Promise<Record<string, unknown>[]> {
  const rows = await selectRows(
    "deposit_addresses",
    [{ column: "active", operator: "eq", value: 1 }],
    { order: "sort_order.asc,id.asc" },
  );
  return rows.map((row) => serializeAddress(row));
}

// 结算该用户所有到期轮次（调用数据库函数）
export async function settleDueRounds(userId: number): Promise<void> {
  callRpc("settle_due_rounds", { p_user_id: userId });
}

export async function buildState(session: SessionContext): Promise<Record<string, unknown>> {
  const userId = session.user.id;
  await settleDueRounds(userId);

  const [freshUser, rounds, history, holdings, requests, pendingWithdraw, gifts, poolRows] = await Promise.all([
    selectOne("users", [{ column: "id", operator: "eq", value: userId }]),
    selectRows("rounds", [{ column: "user_id", operator: "eq", value: userId }], {
      order: "started_at.desc",
    }),
    selectRows("wallet_events", [{ column: "user_id", operator: "eq", value: userId }], {
      order: "id.desc",
      limit: 20,
      columns: "kind,amount_units,created_at",
    }),
    selectRows(
      "holdings",
      [{ column: "user_id", operator: "eq", value: userId }],
      { order: "id.desc", columns: "id,slug,status,started_at,earned_units" },
    ).then(async (rows) => {
      // 礼物名称需要关联 gifts 表
      const catalog = new Map((await giftCatalog()).map((gift) => [String(gift["slug"]), gift]));
      return rows.map((row) => serializeHolding({
        ...row,
        name: catalog.get(String(row["slug"]))?.["name"] ?? row["slug"],
        english: catalog.get(String(row["slug"]))?.["english"] ?? "",
      }));
    }),
    selectRows("wallet_requests", [
      { column: "user_id", operator: "eq", value: userId },
    ], {
      order: "created_at.desc",
      limit: 50,
      columns: "id,kind,amount_units,status,created_at,resolved_at,resolution_note",
    }),
    selectOne("wallet_requests", [
      { column: "user_id", operator: "eq", value: userId },
      { column: "kind", operator: "eq", value: "withdraw" },
      { column: "status", operator: "eq", value: "pending" },
    ], "amount_units").then((row) => num(row?.["amount_units"])),
    giftCatalog(),
    poolRules(),
  ]);

  void gifts;
  void pendingWithdraw;

  return {
    user: {
      ...publicUser(freshUser as Row),
      pendingWithdrawUnits: pendingWithdraw,
    },
    csrfToken: session.csrf,
    poolRules: poolRows.map((rule) => ({
      level: num(rule["level"]),
      name: String(rule["name"] ?? ""),
      minimumUnits: num(rule["minimum_units"]),
      entryUnits: num(rule["entry_units"]),
      duration: num(rule["duration_seconds"]),
      profitPercent: num(rule["profit_percent"]),
      winProbabilityBp: num(rule["win_probability_bp"]),
      enabled: num(rule["enabled"]) === 1,
    })),
    gifts: gifts.filter((gift) => num(gift["active"]) === 1).map((gift) => ({
      slug: String(gift["slug"]),
      name: String(gift["name"]),
      english: String(gift["english"]),
      category: String(gift["category"]),
      imageUrl: String(gift["image_url"] ?? ""),
    })),
    rounds: rounds.map((row) => publicRound(row)),
    walletHistory: history.map((row) => ({
      kind: String(row["kind"]),
      amount: num(row["amount_units"]),
      createdAt: String(row["created_at"]),
    })),
    walletRequests: requests.map((row) => serializeWalletRequest(row)),
    holdings,
    depositAddresses: await publicDepositAddresses(),
  };
}

// ---------------- 管理 / 代理后台 ----------------

interface ScopeSql {
  where: string;
  params: Record<string, number>;
}

function scopeFor(session: SessionContext): ScopeSql | null {
  if (session.user.role === "admin") return null;
  if (session.user.role === "agent") {
    return { where: "users.invited_by = :agentId", params: { agentId: session.user.id } };
  }
  return { where: "users.id = -1", params: {} };
}

export async function adminStats(scope: ScopeSql | null): Promise<Record<string, number>> {
  const roleFilter: Filter[] = [];
  roleFilter.push({ column: "role", operator: "eq", value: "user" });
  const userCount = scope
    ? num((await selectOne("users", [
      ...roleFilter,
      { column: "invited_by", operator: "eq", value: scope.params.agentId ?? -1 },
    ], "id")) ? 1 : 0)
    : await countRows("users", roleFilter);

  const activeUsers = scope
    ? await countRows("users", [
      ...roleFilter,
      { column: "status", operator: "eq", value: "active" },
      { column: "invited_by", operator: "eq", value: scope.params.agentId ?? -1 },
    ])
    : await countRows("users", [
      ...roleFilter,
      { column: "status", operator: "eq", value: "active" },
    ]);

  const agentFilter: Filter[] = [{ column: "role", operator: "eq", value: "agent" }];
  const agentCount = await countRows("users", agentFilter);
  const activeAgents = await countRows("users", [
    ...agentFilter,
    { column: "status", operator: "eq", value: "active" },
  ]);

  const pendingWithdraw = await selectRows(
    "wallet_requests",
    [
      { column: "kind", operator: "eq", value: "withdraw" },
      { column: "status", operator: "eq", value: "pending" },
    ],
    { columns: "amount_units" },
  ).then((rows) => rows.reduce((sum: number, row: Row) => sum + num(row["amount_units"]), 0));

  const userRows = scope
    ? await selectRows("users", [
      ...roleFilter,
      { column: "invited_by", operator: "eq", value: scope.params.agentId ?? -1 },
    ], { columns: "balance_units" })
    : await selectRows("users", [
      { column: "role", operator: "in", value: "(user,agent)" },
    ], { columns: "balance_units" });
  const totalBalance = userRows.reduce((sum: number, row: Row) => sum + num(row["balance_units"]), 0) + pendingWithdraw;

  const openRounds = await countRows("rounds", [{ column: "settled_at", operator: "is", value: null }]);
  const roundCount = await countRows("rounds", []);
  const walletEventCount = await countRows("wallet_events", []);
  const walletVolume = await selectRows("wallet_events", [], { columns: "amount_units" })
    .then((rows) => rows.reduce((sum: number, row: Row) => sum + num(row["amount_units"]), 0));
  const pendingRequests = await countRows("wallet_requests", [
    { column: "status", operator: "eq", value: "pending" },
  ]);

  return {
    userCount,
    activeUsers,
    suspendedUsers: userCount - activeUsers,
    agentCount,
    activeAgents,
    suspendedAgents: agentCount - activeAgents,
    totalBalanceUnits: totalBalance,
    roundCount,
    openRounds,
    walletEventCount,
    walletVolumeUnits: walletVolume,
    pendingWalletRequests: pendingRequests,
  };
}

export async function adminDashboard(
  session: SessionContext,
  options: { page?: number; agentPage?: number; roundsPage?: number; holdingsPage?: number; walletPage?: number; auditPage?: number } = {},
): Promise<Record<string, unknown>> {
  const scope = scopeFor(session);
  const perPage = ADMIN_PAGE_SIZE;
  const offset = (page: number) => (page - 1) * perPage;

  const userFilters: Filter[] = [{ column: "role", operator: "eq", value: "user" }];
  if (scope) userFilters.push({ column: "invited_by", operator: "eq", value: scope.params.agentId ?? -1 });
  const agentFilters: Filter[] = [{ column: "role", operator: "eq", value: "agent" }];

  const userTotal = await countRows("users", userFilters);
  const agentTotal = await countRows("users", agentFilters);
  const roundTotal = await countRows("rounds", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : []);
  const holdingTotal = await countRows("holdings", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : []);
  const walletEventTotal = await countRows("wallet_events", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : []);
  const walletRequestTotal = await countRows("wallet_requests", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : []);
  const auditTotal = scope ? 0 : await countRows("admin_audit", []);

  const userMeta = pageMeta(userTotal, options.page);
  const agentMeta = pageMeta(agentTotal, options.agentPage);
  const roundMeta = pageMeta(roundTotal, options.roundsPage);
  const holdingsMeta = pageMeta(holdingTotal, options.holdingsPage);
  const walletMeta = pageMeta(walletRequestTotal, options.walletPage);
  const eventMeta = pageMeta(walletEventTotal, options.walletPage);
  const auditMeta = pageMeta(auditTotal, options.auditPage);

  const users = await selectRows("users", userFilters, {
    order: "id.desc",
    limit: perPage,
    offset: offset(userMeta.page),
  });
  const agents = await selectRows("users", agentFilters, {
    order: "id.desc",
    limit: perPage,
    offset: offset(agentMeta.page),
  });
  const rounds = await selectRows("rounds", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : [], { order: "started_at.desc,id.desc", limit: perPage, offset: offset(roundMeta.page) });
  const holdings = await selectRows("holdings", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : [], { order: "id.desc", limit: perPage, offset: offset(holdingsMeta.page) });
  const walletEvents = await selectRows("wallet_events", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : [], { order: "id.desc", limit: perPage, offset: offset(eventMeta.page) });
  const walletRequests = await selectRows("wallet_requests", scope
    ? [{ column: "user_id", operator: "in", value: `(select id from users where invited_by = ${scope.params.agentId ?? -1})` }]
    : [], { order: "created_at.desc,id.desc", limit: perPage, offset: offset(walletMeta.page) });
  const audit = scope ? [] : await selectRows("admin_audit", [], {
    order: "id.desc",
    limit: perPage,
    offset: offset(auditMeta.page),
  });

  // 用户名补全：轮次 / 典藏 / 资金 / 申请都需要 username 字段
  const involvedIds = new Set<number>();
  rounds.forEach((row) => involvedIds.add(num(row["user_id"])));
  holdings.forEach((row) => involvedIds.add(num(row["user_id"])));
  walletEvents.forEach((row) => involvedIds.add(num(row["user_id"])));
  walletRequests.forEach((row) => involvedIds.add(num(row["user_id"])));
  const auditAdminIds = new Set<number>();
  audit.forEach((row) => auditAdminIds.add(num(row["admin_id"])));
  const allIds = new Set<number>([...involvedIds, ...auditAdminIds]);
  const userMap = new Map<number, string>();
  if (allIds.size > 0) {
    const rows = await selectRows("users", [
      { column: "id", operator: "in", value: `(${[...allIds].join(",")})` },
    ], { columns: "id,username" });
    rows.forEach((row) => userMap.set(num(row["id"]), String(row["username"])));
  }
  const requesterIds = new Set<number>();
  walletRequests.forEach((row) => requesterIds.add(num(row["resolved_by"])));
  if (requesterIds.size > 0) {
    const rows = await selectRows("users", [
      { column: "id", operator: "in", value: `(${[...requesterIds].filter((id) => id > 0).join(",")})` },
    ], { columns: "id,username" });
    rows.forEach((row) => userMap.set(num(row["id"]), String(row["username"])));
  }

  const giftCatalogRows = await giftCatalog(true);
  const giftMap = new Map(giftCatalogRows.map((row) => [String(row["slug"]), row]));

  return {
    stats: await adminStats(scope),
    users: buildPage(
      users.map((row) => ({ ...publicUser(row), status: String(row["status"]), balanceUnits: num(row["balance_units"]), createdAt: String(row["created_at"]) })),
      userMeta,
    ),
    agents: buildPage(
      agents.map((row) => ({ ...publicUser(row), status: String(row["status"]), balanceUnits: num(row["balance_units"]), createdAt: String(row["created_at"]) })),
      agentMeta,
    ),
    poolRules: (await poolRules()).map((rule) => ({
      level: num(rule["level"]),
      name: String(rule["name"]),
      minimumUnits: num(rule["minimum_units"]),
      entryUnits: num(rule["entry_units"]),
      duration: num(rule["duration_seconds"]),
      profitPercent: num(rule["profit_percent"]),
      winProbabilityBp: num(rule["win_probability_bp"]),
      enabled: num(rule["enabled"]) === 1,
    })),
    gifts: giftCatalogRows.map((gift) => ({
      slug: String(gift["slug"]),
      name: String(gift["name"]),
      english: String(gift["english"]),
      category: String(gift["category"]),
      active: num(gift["active"]) === 1,
    })),
    holdings: buildPage(
      holdings.map((row) => serializeAdminHolding({
        ...row,
        username: userMap.get(num(row["user_id"])) ?? "",
        name: String(giftMap.get(String(row["slug"]))?.["name"] ?? ""),
        english: String(giftMap.get(String(row["slug"]))?.["english"] ?? ""),
      })),
      holdingsMeta,
    ),
    rounds: buildPage(
      rounds.map((row) => serializeAdminRound({ ...row, username: userMap.get(num(row["user_id"])) ?? "" })),
      roundMeta,
    ),
    walletEvents: buildPage(
      walletEvents.map((row) => serializeWalletEvent({ ...row, username: userMap.get(num(row["user_id"])) ?? "" })),
      eventMeta,
    ),
    walletRequests: buildPage(
      walletRequests.map((row) => serializeWalletRequest({
        ...row,
        username: userMap.get(num(row["user_id"])) ?? "",
        resolved_by_username: num(row["resolved_by"]) > 0 ? userMap.get(num(row["resolved_by"])) ?? null : null,
      })),
      walletMeta,
    ),
    audit: buildPage(
      audit.map((row) => serializeAudit({ ...row, admin: userMap.get(num(row["admin_id"])) ?? "" })),
      auditMeta,
    ),
    viewer: {
      role: scope ? "agent" : "admin",
      invitationCode: session.user.invitation_code ?? null,
    },
  };
}

export { KINDS_ALLOWED, fairnessRoll };
