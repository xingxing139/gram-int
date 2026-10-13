let csrfToken = "";
const loginPanel = document.querySelector("[data-admin-login]");
const dashboard = document.querySelector("[data-admin-dashboard]");
const feedback = document.querySelector("[data-admin-feedback]");
const usersTable = document.querySelector("[data-admin-users]");
const agentsTable = document.querySelector("[data-admin-agents]");
const holdingsTable = document.querySelector("[data-admin-holdings]");
const poolsGrid = document.querySelector("[data-admin-pools]");
const giftsList = document.querySelector("[data-admin-gifts]");
const roundsTable = document.querySelector("[data-admin-rounds]");
const walletEventsTable = document.querySelector("[data-admin-wallet-events]");
const walletRequestsTable = document.querySelector("[data-admin-wallet-requests]");
const auditList = document.querySelector("[data-admin-audit]");
let dashboardData = null;
let viewerRole = "admin";
let currentAdminId = null;
/* 后台所有列表数据统一每页 10 条，由服务端分页 */
const pageState = {
  users: 1,
  agents: 1,
  rounds: 1,
  holdings: 1,
  walletRequests: 1,
  walletEvents: 1,
  audit: 1,
};
/* 各资源对应的筛选器（值变更时重置到第 1 页并重新请求） */
const resourceFilters = {
  users: () => ({
    q: document.querySelector("[data-user-search]").value.trim(),
    status: document.querySelector("[data-user-status-filter]").value,
    role: document.querySelector("[data-user-role-filter]").value,
  }),
  agents: () => ({ q: document.querySelector("[data-user-search]").value.trim() }),
  rounds: () => ({
    q: document.querySelector("[data-round-search]").value.trim(),
    status: document.querySelector("[data-round-risk-filter]").value,
  }),
  holdings: () => ({}),
  walletRequests: () => ({
    q: document.querySelector("[data-wallet-user-search]").value.trim(),
    status: document.querySelector("[data-wallet-request-filter]").value,
    kind: document.querySelector("[data-wallet-kind-filter]").value,
  }),
  walletEvents: () => ({ kind: document.querySelector("[data-wallet-event-filter]").value }),
  audit: () => ({}),
};
const resourceCounters = {
  users: "[data-admin-user-count]",
  agents: "[data-admin-agent-count]",
  rounds: "[data-pagination-total='rounds']",
  holdings: "[data-pagination-total='holdings']",
  walletEvents: "[data-pagination-total='walletEvents']",
  audit: "[data-pagination-total='audit']",
};
const moduleTitles = {
  overview: "平台总览",
  users: "用户管理",
  "create-users": "生成用户",
  agents: "代理管理",
  addresses: "充值地址管理",
  wallet: "充值提现审核",
  rounds: "下注管理",
  pools: "铸造池规则",
  holdings: "用户典藏",
  gifts: "礼物目录管理",
  audit: "操作审计",
};
let depositAddresses = [];
const adminOnlyModules = ["create-users", "agents", "addresses", "pools", "gifts", "audit"];
const roleLabels = { admin: "管理员", agent: "代理", user: "用户" };

/* 后端寻址：本地/局域网走同源后端（ruby server.rb），公网走 Supabase。
   如需强制指定，可在页面加载前设置 window.GRAM_API_BASE。 */
const SUPABASE_FN = "https://gyjqoxbpjlrvemoybktq.supabase.co/functions/v1/api";

function adminApiBase() {
  if (window.GRAM_API_BASE !== undefined) {
    return String(window.GRAM_API_BASE).replace(/\/+$/, "");
  }
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
    host === "[::1]" || /^192\.168\./.test(host) || /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isLocal ? "" : SUPABASE_FN;
}
/* 候选地址：边缘运行时会剥掉 /functions/v1/api 前缀，同一接口可能对应
   两种 URL 形态，逐个尝试，避免因前缀差异整体失败。 */
function adminUrlCandidates(path) {
  const base = adminApiBase();
  if (!base) return [path];
  const first = base + path.replace(/^\/api/, "");
  const second = base + path;
  return first === second ? [first] : [first, second];
}

async function doAdminRequest(target, base, method, headers, options) {
  let response;
  try {
    response = await fetch(target, {
      method,
      credentials: base ? "include" : "same-origin",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    // fetch 本身抛错 = 网络/CORS/超时，调用方据此换地址重试
    throw error;
  }
  let result = {};
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok) {
      const wrapped = new Error("服务器返回了无法读取的数据。");
      wrapped.isHttpError = true;
      throw wrapped;
    }
  }
  if (!response.ok) {
    const wrapped = new Error(result.error || `服务器请求失败（${response.status}）。`);
    wrapped.isHttpError = true;
    throw wrapped;
  }
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}

async function request(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const base = adminApiBase();
  const candidates = adminUrlCandidates(path);
  let lastError = null;
  for (const target of candidates) {
    try {
      return await doAdminRequest(target, base, method, headers, options);
    } catch (error) {
      // 服务端已给出业务应答（含 401 未登录、404 等）必须原样抛出，绝不换地址重试；
      // 只有 fetch 本身抛出的网络级错误才尝试下一个候选地址。
      if (error && error.isHttpError) throw error;
      lastError = error;
    }
  }
  throw new Error(`网络请求失败（${candidates[0]}）：${lastError ? lastError.message : "unknown"}`);
}

function setFeedback(message, type = "error") {
  feedback.textContent = message;
  feedback.classList.toggle("is-success", type === "success");
}

function makeCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function formatUnits(units) {
  return (units / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function renderStats(stats) {
  document.querySelector("[data-stat-users]").textContent = stats.userCount.toLocaleString("zh-CN");
  document.querySelector("[data-stat-user-status]").textContent =
    `正常 ${stats.activeUsers} · 已停用 ${stats.suspendedUsers}`;
  const agentStat = document.querySelector("[data-stat-agents]");
  if (agentStat) {
    agentStat.textContent = (stats.agentCount || 0).toLocaleString("zh-CN");
    document.querySelector("[data-stat-agent-status]").textContent =
      `正常 ${stats.activeAgents || 0} · 已停用 ${stats.suspendedAgents || 0}`;
  }
  document.querySelector("[data-stat-balance]").textContent = formatUnits(stats.totalBalanceUnits);
  document.querySelector("[data-stat-rounds]").textContent = stats.roundCount.toLocaleString("zh-CN");
  document.querySelector("[data-stat-open-rounds]").textContent = `未结算 ${stats.openRounds}`;
  document.querySelector("[data-stat-wallet-count]").textContent = stats.walletEventCount.toLocaleString("zh-CN");
  document.querySelector("[data-stat-wallet-volume]").textContent = formatUnits(stats.walletVolumeUnits);
  document.querySelector("[data-stat-wallet-pending]").textContent = stats.pendingWalletRequests.toLocaleString("zh-CN");
}

/* ---------- 充值地址管理 ---------- */
function addressQrUrl(address) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=120x120&margin=0&data=${encodeURIComponent(address)}`;
}

async function loadDepositAddresses() {
  const result = await request("/api/admin/deposit-addresses");
  depositAddresses = result.addresses || [];
  renderAddresses();
}

function renderAddresses() {
  const tbody = document.querySelector("[data-admin-addresses]");
  if (!tbody) return;
  document.querySelector("[data-address-count]").textContent = `${depositAddresses.length} 个地址`;
  if (!depositAddresses.length) {
    const emptyRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "尚未添加充值地址，用户充值弹窗将提示地址未配置。";
    emptyRow.append(cell);
    tbody.replaceChildren(emptyRow);
    return;
  }
  tbody.replaceChildren(...depositAddresses.map((entry) => {
    const row = document.createElement("tr");
    const qr = document.createElement("img");
    qr.className = "admin-address-qr";
    qr.width = 60;
    qr.height = 60;
    qr.alt = `${entry.label} 二维码`;
    qr.loading = "lazy";
    qr.src = addressQrUrl(entry.address);
    qr.addEventListener("error", () => {
      qr.replaceWith(Object.assign(document.createElement("span"), { textContent: "二维码不可用", className: "admin-hash" }));
    });
    const addressCell = document.createElement("td");
    addressCell.className = "admin-address-cell";
    addressCell.append(qr);
    const code = document.createElement("code");
    code.textContent = entry.address;
    addressCell.append(code);
    row.append(
      makeCell(entry.label),
      addressCell,
      makeCell(entry.note || "—"),
      makeCell(entry.active ? "启用中" : "已停用", entry.active ? "active" : "suspended"),
      makeCell(new Date(entry.createdAt).toLocaleString("zh-CN")),
    );
    const action = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "admin-small-button";
    edit.dataset.addressEdit = entry.id;
    edit.textContent = "编辑";
    action.append(edit);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `admin-small-button ${entry.active ? "admin-danger-button" : ""}`.trim();
    toggle.dataset.addressId = entry.id;
    toggle.dataset.addressActive = String(!entry.active);
    toggle.textContent = entry.active ? "停用" : "启用";
    action.append(toggle);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "admin-small-button admin-danger-button";
    remove.dataset.addressRemove = entry.id;
    remove.textContent = "删除";
    action.append(remove);
    row.append(action);
    return row;
  }));
}

function resetAddressForm() {
  const form = document.querySelector("[data-address-form]");
  form.reset();
  form.querySelector('button[type="submit"]').textContent = "保存地址";
}

document.querySelector("[data-address-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  const id = values.get("id");
  const body = {
    label: String(values.get("label") || "").trim(),
    address: String(values.get("address") || "").trim(),
    note: String(values.get("note") || "").trim(),
  };
  button.disabled = true;
  try {
    if (id) {
      await request(`/api/admin/deposit-addresses/${encodeURIComponent(id)}`, { method: "PATCH", body });
      setFeedback("充值地址已更新；用户端二维码同步刷新。", "success");
    } else {
      await request("/api/admin/deposit-addresses", { method: "POST", body });
      setFeedback("充值地址已添加。", "success");
    }
    resetAddressForm();
    await loadDepositAddresses();
  } catch (error) {
    setFeedback(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("[data-admin-addresses]")?.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-address-edit]");
  if (editButton) {
    const entry = depositAddresses.find((item) => String(item.id) === editButton.dataset.addressEdit);
    if (!entry) return;
    const form = document.querySelector("[data-address-form]");
    form.elements.id.value = String(entry.id);
    form.elements.label.value = entry.label;
    form.elements.address.value = entry.address;
    form.elements.note.value = entry.note || "";
    form.querySelector('button[type="submit"]').textContent = "保存修改";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    form.elements.label.focus();
    return;
  }
  const toggleButton = event.target.closest("[data-address-id]");
  if (toggleButton) {
    const active = toggleButton.dataset.addressActive === "true";
    toggleButton.disabled = true;
    try {
      await request(`/api/admin/deposit-addresses/${encodeURIComponent(toggleButton.dataset.addressId)}/status`, {
        method: "PATCH",
        body: { active },
      });
      await loadDepositAddresses();
      setFeedback(active ? "地址已启用。" : "地址已停用，用户端不再展示。", "success");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      toggleButton.disabled = false;
    }
    return;
  }
  const removeButton = event.target.closest("[data-address-remove]");
  if (removeButton) {
    if (!window.confirm("删除后用户端将不再展示该地址，确定删除？")) return;
    removeButton.disabled = true;
    try {
      await request(`/api/admin/deposit-addresses/${encodeURIComponent(removeButton.dataset.addressRemove)}`, { method: "DELETE" });
      await loadDepositAddresses();
      resetAddressForm();
      setFeedback("充值地址已删除。", "success");
    } catch (error) {
      setFeedback(error.message);
    } finally {
      removeButton.disabled = false;
    }
  }
});

function renderUsers() {
  if (!dashboardData) return;
  const page = dashboardData.users;
  const users = page.items || [];
  const directory = new Map(users.map((user) => [user.id, user]));
  document.querySelector("[data-admin-user-count]").textContent = `${page.total} 个账户`;
  usersTable.replaceChildren(...users.map((user) => {
    const row = document.createElement("tr");
    row.append(
      makeCell(`#${user.id} · ${user.displayName} (@${user.username})`),
      makeCell(roleLabels[user.role] || user.role),
      makeCell(user.invitationCode || "—", "admin-code"),
      makeCell(inviterName(user, directory)),
      makeCell(user.status === "active" ? "正常" : "已停用", user.status),
      makeCell(`${formatUnits(user.balanceUnits)} G`),
      makeCell(new Date(user.createdAt).toLocaleString("zh-CN")),
    );
    const action = document.createElement("td");
    if (viewerRole === "admin" && user.role !== "admin") {
      const button = document.createElement("button");
      button.className = `admin-small-button ${user.status === "active" ? "admin-danger-button" : ""}`;
      button.type = "button";
      button.dataset.userId = user.id;
      button.dataset.userStatus = user.status === "active" ? "suspended" : "active";
      button.textContent = user.status === "active" ? "停用账户" : "恢复账户";
      action.append(button);
      const adjust = document.createElement("button");
      adjust.className = "admin-small-button";
      adjust.type = "button";
      adjust.dataset.userAdjust = user.id;
      adjust.textContent = "调整余额";
      action.append(adjust);
      const renew = document.createElement("button");
      renew.className = "admin-small-button";
      renew.type = "button";
      renew.dataset.userInvitation = user.id;
      renew.textContent = "重生成邀请码";
      action.append(renew);
    } else {
      action.textContent = "—";
    }
    row.append(action);
    return row;
  }));
  updatePagination("users", page);
}

function inviterName(user, directory) {
  if (!user.invitedBy) return "平台直属";
  const parent = directory.get(Number(user.invitedBy));
  return parent ? `#${parent.id} ${parent.username}` : `#${user.invitedBy}`;
}

function renderAgents() {
  if (!agentsTable) return;
  const page = dashboardData.agents;
  const agents = page.items || [];
  const downlineCounts = new Map();
  (dashboardData.users.items || []).forEach((user) => {
    if (user.invitedBy) {
      downlineCounts.set(Number(user.invitedBy), (downlineCounts.get(Number(user.invitedBy)) || 0) + 1);
    }
  });
  document.querySelector("[data-admin-agent-count]").textContent = `${page.total} 个代理`;
  agentsTable.replaceChildren(...agents.map((agent) => {
    const row = document.createElement("tr");
    row.append(
      makeCell(`#${agent.id} · ${agent.displayName} (@${agent.username})`),
      makeCell(agent.invitationCode || "—", "admin-code"),
      makeCell(agent.status === "active" ? "正常" : "已停用", agent.status),
      makeCell(`${downlineCounts.get(agent.id) || 0} 人`),
      makeCell(new Date(agent.createdAt).toLocaleString("zh-CN")),
    );
    const action = document.createElement("td");
    const renew = document.createElement("button");
    renew.className = "admin-small-button";
    renew.type = "button";
    renew.dataset.userInvitation = agent.id;
    renew.textContent = "重生成邀请码";
    action.append(renew);
    if (agent.id !== currentAdminId) {
      const button = document.createElement("button");
      button.className = `admin-small-button ${agent.status === "active" ? "admin-danger-button" : ""}`;
      button.type = "button";
      button.dataset.userId = agent.id;
      button.dataset.userStatus = agent.status === "active" ? "suspended" : "active";
      button.textContent = agent.status === "active" ? "停用" : "恢复";
      action.append(button);
    }
    row.append(action);
    return row;
  }));
  updatePagination("agents", page);
}

function renderHoldings() {
  if (!dashboardData) return;
  const page = dashboardData.holdings;
  const holdings = page.items || [];
  document.querySelector("[data-pagination-total='holdings']").textContent = `共 ${page.total} 件`;
  holdingsTable.replaceChildren(...holdings.map((holding) => {
    const row = document.createElement("tr");
    row.append(
      makeCell(`${holding.username} (#${holding.userId})`),
      makeCell(`${holding.name} · ${holding.english} (${holding.slug})`),
      makeCell(holding.status === "owned" ? "持有中" : holding.status === "rental" ? "出租中" : "生息中"),
    );
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-small-button";
    button.dataset.holdingId = holding.id;
    button.textContent = "移除记录";
    action.append(button);
    row.append(action);
    return row;
  }));
  updatePagination("holdings", page);
}

function renderPools(pools) {
  poolsGrid.replaceChildren(...pools.map((pool) => {
    const form = document.createElement("form");
    form.className = "admin-pool-form";
    form.dataset.poolLevel = pool.level;
    form.innerHTML = `
      <div class="admin-pool-heading"><strong>LV.${String(pool.level).padStart(2, "0")} ${pool.name}</strong><label class="admin-switch"><input name="enabled" type="checkbox" ${pool.enabled ? "checked" : ""}><span>开放</span></label></div>
      <label>账户门槛（GRAM）<input name="entry" type="number" min="0.01" step="0.01" value="${pool.entryUnits / 100}" required></label>
      <label>最低下注（GRAM）<input name="minimum" type="number" min="0.01" step="0.01" value="${pool.minimumUnits / 100}" required></label>
      <label>倒计时（秒）<input name="duration" type="number" min="1" max="86400" step="1" value="${pool.duration}" required></label>
      <label>公开中奖概率（%）<input name="probability" type="number" min="0" max="100" step="0.01" value="${pool.winProbabilityBp / 100}" required></label>
      <label>盈利率（%）<input name="profit" type="number" min="0" max="500" step="1" value="${pool.profitPercent}" required></label>
      <button class="admin-primary" type="submit">保存规则</button>
      <small>更新后对新轮次生效，进行中的轮次使用已公开的规则快照。</small>`;
    return form;
  }));
}

function renderGifts(gifts) {
  giftsList.replaceChildren(...gifts.map((gift) => {
    const form = document.createElement("form");
    form.className = "admin-gift-row";
    form.dataset.giftSlug = gift.slug;
    form.dataset.giftIsActive = String(gift.active);
    const slug = document.createElement("code");
    slug.textContent = gift.slug;
    const name = document.createElement("input");
    name.name = "name";
    name.value = gift.name;
    name.maxLength = 80;
    name.required = true;
    name.setAttribute("aria-label", `${gift.slug} 中文名称`);
    const english = document.createElement("input");
    english.name = "english";
    english.value = gift.english;
    english.maxLength = 80;
    english.required = true;
    english.setAttribute("aria-label", `${gift.slug} 英文名称`);
    const category = document.createElement("input");
    category.name = "category";
    category.value = gift.category;
    category.maxLength = 80;
    category.required = true;
    category.setAttribute("aria-label", `${gift.slug} 分类`);
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "admin-small-button";
    save.textContent = "保存";
    const active = document.createElement("button");
    active.type = "button";
    active.className = "admin-small-button";
    active.dataset.giftActive = String(!gift.active);
    active.textContent = gift.active ? "下架" : "上架";
    form.append(slug, name, english, category, save, active);
    return form;
  }));
}

const forcedOutcomeLabels = { win: "包赢", lose: "包输" };

function renderRounds() {
  if (!dashboardData) return;
  const page = dashboardData.rounds;
  const rounds = page.items || [];
  document.querySelector("[data-pagination-total='rounds']").textContent = `共 ${page.total} 条`;
  roundsTable.replaceChildren(...rounds.map((round) => {
    const row = document.createElement("tr");
    const forced = forcedOutcomeLabels[round.forcedOutcome] || null;
    row.append(
      makeCell(`${round.username} (#${round.userId}) · ${round.id.slice(0, 8)}`),
      makeCell(`LV.${String(round.level).padStart(2, "0")}`),
      makeCell(`${formatUnits(round.betAmount)} G`),
      makeCell(`${(round.winProbabilityBp / 100).toFixed(2).replace(/\.?0+$/, "")}%`),
      makeCell(forced || "随机", forced ? "suspended" : ""),
      makeCell(round.won === null ? "进行中" : round.won ? "盈利" : "亏损", round.won === null ? "" : round.won ? "active" : "suspended"),
      makeCell(round.riskFlag ? `已标记：${round.riskNote}` : "未标记", round.riskFlag ? "suspended" : "active"),
      makeCell(round.fairnessCommitment, "admin-hash"),
    );
    const action = document.createElement("td");
    if (viewerRole === "admin" && round.settled === false) {
      for (const [outcome, label, className] of [
        ["win", "包赢", "admin-approve-button"],
        ["lose", "包输", "admin-danger-button"],
        ["reset", "恢复随机", ""],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `admin-small-button ${className}`.trim();
        button.dataset.roundOutcomeId = round.id;
        button.dataset.roundOutcome = outcome;
        button.textContent = label;
        action.append(button);
      }
    }
    const riskButton = document.createElement("button");
    riskButton.type = "button";
    riskButton.className = "admin-small-button";
    riskButton.dataset.roundId = round.id;
    riskButton.dataset.roundFlagged = String(!round.riskFlag);
    riskButton.textContent = round.riskFlag ? "清除标记" : "标记风险";
    action.append(riskButton);
    row.append(action);
    return row;
  }));
  updatePagination("rounds", page);
}

function renderWalletEvents() {
  if (!dashboardData) return;
  const page = dashboardData.walletEvents;
  const labels = {
    deposit: "充值",
    withdraw: "提现",
    "mint-win": "铸造返还",
    "mint-loss": "下注扣除",
    "admin-credit": "管理员入账",
    "admin-debit": "管理员扣除",
    "withdraw-release": "提现取消解冻",
    "collectible-reward": "典藏收益",
  };
  const rows = page.items || [];
  document.querySelector("[data-pagination-total='walletEvents']").textContent = `共 ${page.total} 笔`;
  walletEventsTable.replaceChildren(...rows.map((entry) => {
    const row = document.createElement("tr");
    row.append(
      makeCell(`#${entry.id}`),
      makeCell(`${entry.username} (#${entry.userId})`),
      makeCell(labels[entry.kind] || entry.kind),
      makeCell(`${formatUnits(entry.amountUnits)} G`),
      makeCell(new Date(entry.createdAt).toLocaleString("zh-CN")),
    );
    return row;
  }));
  updatePagination("walletEvents", page);
}

function renderAudit() {
  if (!dashboardData) return;
  const page = dashboardData.audit;
  const entries = page.items || [];
  document.querySelector("[data-pagination-total='audit']").textContent = `共 ${page.total} 条`;
  auditList.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("article");
    item.className = "admin-audit-entry";
    const heading = document.createElement("strong");
    heading.textContent = `${entry.action} · ${entry.admin}`;
    const date = document.createElement("time");
    date.textContent = new Date(entry.createdAt).toLocaleString("zh-CN");
    const detail = document.createElement("code");
    detail.textContent = JSON.stringify(entry.detail);
    item.append(heading, date, detail);
    return item;
  }));
  updatePagination("audit", page);
}

function renderWalletRequests() {
  if (!dashboardData) return;
  const page = dashboardData.walletRequests;
  const requests = page.items || [];
  const pendingCount = dashboardData.stats.pendingWalletRequests;
  document.querySelector("[data-wallet-pending-count]").textContent = `待审核 ${pendingCount} 笔`;
  walletRequestsTable.replaceChildren(...requests.map((item) => {
    const row = document.createElement("tr");
    const statusText = item.status === "pending" ? "待审核" : item.status === "approved" ? "已确认" : "已取消";
    const statusClass = item.status === "pending" ? "" : item.status === "approved" ? "active" : "suspended";
    row.append(
      makeCell(item.id.slice(0, 8)),
      makeCell(`${item.username} (#${item.userId})`),
      makeCell(item.kind === "deposit" ? "充值" : "提现"),
      makeCell(`${formatUnits(item.amountUnits)} G`),
      makeCell(item.address || "—"),
      makeCell(new Date(item.createdAt).toLocaleString("zh-CN")),
      makeCell(`${statusText}${item.resolutionNote ? ` · ${item.resolutionNote}` : ""}`, statusClass),
    );
    const action = document.createElement("td");
    if (item.status === "pending") {
      for (const [decision, label, className] of [
        ["approve", "确认", "admin-approve-button"],
        ["cancel", "取消", "admin-danger-button"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `admin-small-button ${className}`;
        button.dataset.walletRequestId = item.id;
        button.dataset.walletDecision = decision;
        button.textContent = label;
        action.append(button);
      }
    } else {
      action.textContent = item.resolvedBy ? `审核：${item.resolvedBy}` : "已处理";
    }
    row.append(action);
    return row;
  }));
  updatePagination("walletRequests", page);
}

function activateModule(moduleId, updateLocation = true) {
  const id = moduleTitles[moduleId] ? moduleId : "overview";
  const isAdmin = viewerRole === "admin";
  const visible = isAdmin ? id : (adminOnlyModules.includes(id) ? "users" : id);
  document.querySelectorAll(".admin-content > section").forEach((section) => {
    section.hidden = section.id !== visible;
  });
  document.querySelectorAll(".admin-nav a").forEach((link) => {
    const hashModule = link.hash.slice(1);
    const active = hashModule === visible;
    link.classList.toggle("is-active", active);
    link.hidden = !isAdmin && adminOnlyModules.includes(hashModule);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelector("[data-admin-page-title]").textContent = moduleTitles[visible];
  if (updateLocation && window.location.hash !== `#${visible}`) {
    window.history.replaceState(null, "", `#${visible}`);
  }
}

/* ---------- 分页 ---------- */
function updatePagination(resource, page) {
  const info = document.querySelector(`[data-pagination-info="${resource}"]`);
  const wrapper = document.querySelector(`[data-pagination="${resource}"]`);
  if (info) info.textContent = `第 ${page.page} / ${page.totalPages} 页 · 共 ${page.total} 条`;
  if (!wrapper) return;
  const buttons = wrapper.querySelectorAll("[data-page-step]");
  buttons.forEach((button) => {
    const step = Number(button.dataset.pageStep);
    const disabled = step < 0 ? page.page <= 1 : page.page >= page.totalPages;
    button.disabled = disabled;
    button.classList.toggle("admin-danger-button", false);
  });
  const counter = document.querySelector(resourceCounters[resource]);
  if (counter && resource === "rounds") counter.textContent = `共 ${page.total} 条`;
}

async function fetchResource(resource, page) {
  const filters = resourceFilters[resource] ? resourceFilters[resource]() : {};
  const params = new URLSearchParams({ resource, page: String(page) });
  Object.entries(filters).forEach(([key, value]) => {
    if (value && value !== "all") params.set(key, value);
  });
  const data = await request(`/api/admin/list?${params.toString()}`);
  dashboardData[resource] = data;
  pageState[resource] = data.page;
  renderResource(resource);
}

function renderResource(resource) {
  if (resource === "users") renderUsers();
  else if (resource === "agents") renderAgents();
  else if (resource === "rounds") renderRounds();
  else if (resource === "holdings") renderHoldings();
  else if (resource === "walletRequests") renderWalletRequests();
  else if (resource === "walletEvents") renderWalletEvents();
  else if (resource === "audit") renderAudit();
}

function resetResource(resource) {
  pageState[resource] = 1;
  fetchResource(resource, 1);
}

document.querySelectorAll("[data-page-step]").forEach((button) => {
  button.addEventListener("click", () => {
    const resource = button.dataset.pageTarget;
    const step = Number(button.dataset.pageStep);
    const page = Math.max(1, pageState[resource] + step);
    if (page === pageState[resource]) return;
    fetchResource(resource, page);
  });
});

function renderDashboard(data, user) {
  dashboardData = data;
  viewerRole = data.viewer && data.viewer.role === "agent" ? "agent" : (user && user.role === "agent" ? "agent" : "admin");
  currentAdminId = user && user.id ? user.id : null;
  document.querySelector("[data-admin-username]").textContent = user.displayName || user.username;
  const modeLabel = document.querySelector(".admin-mode");
  if (modeLabel && modeLabel.lastChild) {
    modeLabel.lastChild.textContent = viewerRole === "agent" ? "代理后台" : "管理后台";
  }
  renderStats(data.stats);
  renderUsers();
  renderWalletEvents();
  renderPools(data.poolRules);
  renderHoldings();
  renderGifts(data.gifts);
  renderRounds();
  renderAudit();
  renderWalletRequests();
  renderAgents();
  const userFormSection = document.querySelector("#create-users");
  if (userFormSection) userFormSection.hidden = viewerRole !== "admin";
  const agentsSection = document.querySelector("#agents");
  if (agentsSection) agentsSection.hidden = viewerRole !== "admin";
  const addressSection = document.querySelector("#addresses");
  if (addressSection) addressSection.hidden = viewerRole !== "admin";
  if (viewerRole === "admin") loadDepositAddresses().catch((error) => setFeedback(error.message));
  activateModule(window.location.hash.slice(1), false);
  loginPanel.hidden = true;
  dashboard.hidden = false;
  document.querySelector("[data-admin-logout]").hidden = false;
}

async function loadDashboard(user) {
  const role = user && user.role;
  const path = role === "agent" ? "/api/agent" : "/api/admin";
  try {
    const data = await request(path);
    renderDashboard(data, user);
  } catch (error) {
    // 登录刚成功却拿不到会话，说明浏览器没有保留跨站 Cookie
    if (error.message === "请先登录。") {
      throw new Error("登录态未被浏览器保留（跨站 Cookie 被拦截）。请改用本地后台 http://127.0.0.1:9292/admin.html ，或在浏览器设置中允许第三方 Cookie。");
    }
    throw error;
  }
}

document.querySelector("[data-admin-login-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const loginFeedback = document.querySelector("[data-admin-login-feedback]");
  loginFeedback.textContent = "";
  button.disabled = true;
  try {
    const result = await request("/api/login", {
      method: "POST",
      body: { username: form.elements.username.value, password: form.elements.password.value },
    });
    csrfToken = result.csrfToken;
    form.reset();
    await loadDashboard(result.user);
  } catch (error) {
    loginFeedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("[data-user-search]").addEventListener("input", () => resetResource("users"));
document.querySelector("[data-user-status-filter]").addEventListener("change", () => resetResource("users"));
document.querySelector("[data-user-role-filter]")?.addEventListener("change", () => resetResource("users"));
document.querySelector("[data-user-filter-reset]")?.addEventListener("click", () => {
  document.querySelector("[data-user-search]").value = "";
  document.querySelector("[data-user-status-filter]").value = "all";
  const roleFilter = document.querySelector("[data-user-role-filter]");
  if (roleFilter) roleFilter.value = "all";
  resetResource("users");
});
document.querySelector("[data-wallet-kind-filter]").addEventListener("change", () => resetResource("walletRequests"));
document.querySelector("[data-wallet-request-filter]").addEventListener("change", () => resetResource("walletRequests"));
document.querySelector("[data-wallet-event-filter]").addEventListener("change", () => resetResource("walletEvents"));
document.querySelector("[data-wallet-user-search]").addEventListener("input", () => resetResource("walletRequests"));
document.querySelector("[data-round-search]").addEventListener("input", () => resetResource("rounds"));
document.querySelector("[data-round-risk-filter]").addEventListener("change", () => resetResource("rounds"));

async function handleInvitationRegenerate(button) {
  const targetId = button.dataset.userInvitation;
  if (!window.confirm("重新生成该账户的邀请码？旧邀请码将立即失效。")) return;
  button.disabled = true;
  try {
    const result = await request(`/api/admin/users/${encodeURIComponent(targetId)}/invitation`, {
      method: "PATCH",
      body: {},
    });
    await fetchResource("users", pageState.users);
    setFeedback(`邀请码已更新：${result.invitationCode}`, "success");
  } catch (error) {
    setFeedback(error.message);
  } finally {
    button.disabled = false;
  }
}

async function handleUserStatusChange(button) {
  const reason = window.prompt(
    button.dataset.userStatus === "suspended"
      ? "停用原因（至少 3 个字符，将记录在审计日志中）："
      : "恢复原因（至少 3 个字符，将记录在审计日志中）：",
  );
  if (reason === null) return;
  button.disabled = true;
  try {
    await request(`/api/admin/users/${button.dataset.userId}`, {
      method: "PATCH",
      body: { status: button.dataset.userStatus, reason },
    });
    await fetchResource("users", pageState.users);
    setFeedback("用户状态已更新并记录审计日志。", "success");
  } catch (error) {
    button.disabled = false;
    setFeedback(error.message);
  }
}

function wireAdminActions(table) {
  if (!table) return;
  table.addEventListener("click", async (event) => {
    const invitationButton = event.target.closest("[data-user-invitation]");
    if (invitationButton) {
      await handleInvitationRegenerate(invitationButton);
      return;
    }
    const statusButton = event.target.closest("[data-user-id]");
    if (statusButton) {
      await handleUserStatusChange(statusButton);
    }
  });
}

wireAdminActions(usersTable);
wireAdminActions(agentsTable);

usersTable.addEventListener("click", async (event) => {
  const adjustButton = event.target.closest("[data-user-adjust]");
  if (!adjustButton) return;
  const amountText = window.prompt("输入余额调整额（GRAM，正数入账，负数扣除）：");
  if (amountText === null) return;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 20_000_000) {
    setFeedback("请输入非零且不超过 20,000,000 GRAM 的有效金额。");
    return;
  }
  const reason = window.prompt("请填写审计原因：");
  if (reason === null) return;
  adjustButton.disabled = true;
  try {
    await request(`/api/admin/users/${adjustButton.dataset.userAdjust}/balance`, {
      method: "PATCH",
      body: { deltaUnits: Math.round(amount * 100), reason },
    });
    await fetchResource("users", pageState.users);
    setFeedback("余额已调整并记录审计日志。", "success");
  } catch (error) {
    adjustButton.disabled = false;
    setFeedback(error.message);
  }
});

holdingsTable.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-holding-id]");
  if (!button) return;
  if (!window.confirm("移除该用户的典藏记录？")) return;
  button.disabled = true;
  try {
    await request(`/api/admin/holdings/${encodeURIComponent(button.dataset.holdingId)}`, { method: "DELETE" });
    await fetchResource("holdings", pageState.holdings);
    setFeedback("典藏记录已移除并记录审计日志。");
  } catch (error) {
    button.disabled = false;
    setFeedback(error.message);
  }
});

const roundOutcomeConfirmations = {
  win: "确定将该未结算轮次设置为包赢？结算时用户将获得收益。",
  lose: "确定将该未结算轮次设置为包输？结算时扣除下注额。",
  reset: "确定取消干预并恢复为随机承诺值原本决定的结果？",
};
const roundOutcomeDoneMessages = {
  win: "已设置为包赢，结算时按包赢派奖。",
  lose: "已设置为包输，结算时按包输派奖。",
  reset: "已取消干预，恢复随机结果。",
};

roundsTable.addEventListener("click", async (event) => {
  const outcomeButton = event.target.closest("[data-round-outcome-id]");
  if (outcomeButton) {
    const outcome = outcomeButton.dataset.roundOutcome;
    if (!roundOutcomeConfirmations[outcome]) return;
    if (!window.confirm(roundOutcomeConfirmations[outcome])) return;
    outcomeButton.disabled = true;
    try {
      await request(`/api/admin/rounds/${encodeURIComponent(outcomeButton.dataset.roundOutcomeId)}/outcome`, {
        method: "PATCH",
        body: { outcome },
      });
      await fetchResource("rounds", pageState.rounds);
      setFeedback(roundOutcomeDoneMessages[outcome]);
    } catch (error) {
      outcomeButton.disabled = false;
      setFeedback(error.message);
    }
    return;
  }
  const button = event.target.closest("[data-round-id]");
  if (!button) return;
  const flagged = button.dataset.roundFlagged === "true";
  const reason = flagged
    ? window.prompt("风险标记原因（至少 3 个字符）：")
    : "管理员复核后清除风险标记";
  if (reason === null) return;
  button.disabled = true;
  try {
    await request(`/api/admin/rounds/${encodeURIComponent(button.dataset.roundId)}/risk`, {
      method: "PATCH",
      body: { flagged, reason },
    });
    await fetchResource("rounds", pageState.rounds);
    setFeedback(flagged
      ? "下注已标记供后续风控审核；既有结算与随机结果未改变。"
      : "已清除风险标记；结算记录未改变。");
  } catch (error) {
    button.disabled = false;
    setFeedback(error.message);
  }
});

walletRequestsTable.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-wallet-request-id]");
  if (!button) return;
  const decision = button.dataset.walletDecision;
  const reason = window.prompt(
    decision === "approve"
      ? "填写确认备注（至少 3 个字符）："
      : "填写取消原因（至少 3 个字符）：",
  );
  if (reason === null) return;
  button.disabled = true;
  try {
    await request(`/api/admin/wallet-requests/${encodeURIComponent(button.dataset.walletRequestId)}`, {
      method: "PATCH",
      body: { decision, reason },
    });
    await fetchResource("walletRequests", pageState.walletRequests);
    setFeedback(decision === "approve" ? "申请已确认并更新账户余额。" : "申请已取消；如为提现，冻结金额已解冻。");
  } catch (error) {
    button.disabled = false;
    setFeedback(error.message);
  }
});

document.querySelectorAll(".admin-nav a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    activateModule(link.hash.slice(1));
  });
});

window.addEventListener("hashchange", () => {
  activateModule(window.location.hash.slice(1), false);
});

poolsGrid.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-pool-level]");
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request(`/api/admin/pools/${form.dataset.poolLevel}`, {
      method: "PATCH",
      body: {
        enabled: values.has("enabled"),
        entryUnits: Math.round(Number(values.get("entry")) * 100),
        minimumUnits: Math.round(Number(values.get("minimum")) * 100),
        durationSeconds: Number(values.get("duration")),
        winProbabilityBp: Math.round(Number(values.get("probability")) * 100),
        profitPercent: Number(values.get("profit")),
      },
    });
    await refreshDashboard();
    setFeedback("铸造池规则已保存；仅影响新开的轮次。");
  } catch (error) {
    button.disabled = false;
    setFeedback(error.message);
  }
});

document.querySelector("[data-admin-gift-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  try {
    await request(`/api/admin/gifts/${encodeURIComponent(values.get("slug"))}`, {
      method: "PUT",
      body: { name: values.get("name"), english: values.get("english"), category: values.get("category"), active: true },
    });
    form.reset();
    await refreshDashboard();
    setFeedback("典藏目录已新增或更新。");
  } catch (error) {
    setFeedback(error.message);
  }
});

document.querySelector("[data-admin-user-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const username = String(values.get("username") || "").trim();
  const password = String(values.get("password") || "");
  const displayName = String(values.get("displayName") || "").trim();
  const invitedByRaw = String(values.get("invitedBy") || "").trim();
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    setFeedback("用户名需为 3–24 位字母、数字或 . _ -。");
    return;
  }
  if (password.length < 8) {
    setFeedback("登录密码至少需要 8 位。");
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request("/api/admin/users", {
      method: "POST",
      body: {
        username,
        password,
        displayName: displayName || username,
        invitedBy: invitedByRaw === "" ? null : Number(invitedByRaw),
      },
    });
    form.reset();
    await fetchResource("users", 1);
    setFeedback(`用户已创建，专属邀请码：${result.user.invitationCode}`);
  } catch (error) {
    setFeedback(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("[data-admin-agent-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const username = String(values.get("username") || "").trim();
  const password = String(values.get("password") || "");
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    setFeedback("代理用户名需为 3–24 位字母、数字或 . _ -。");
    return;
  }
  if (password.length < 8) {
    setFeedback("代理登录密码至少需要 8 位。");
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await request("/api/admin/agents", { method: "POST", body: { username, password } });
    form.reset();
    await fetchResource("agents", 1);
    setFeedback(`代理已添加，专属邀请码：${result.user.invitationCode}（代理使用该邀请码发展用户）`);
  } catch (error) {
    setFeedback(error.message);
  } finally {
    button.disabled = false;
  }
});

giftsList.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-gift-slug]");
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  try {
    await request(`/api/admin/gifts/${encodeURIComponent(form.dataset.giftSlug)}`, {
      method: "PUT",
      body: {
        name: values.get("name"), english: values.get("english"), category: values.get("category"),
        active: form.dataset.giftIsActive === "true",
      },
    });
    await refreshDashboard();
    setFeedback("礼物目录项已保存。");
  } catch (error) {
    setFeedback(error.message);
  }
});

giftsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-gift-active]");
  if (!button) return;
  const form = button.closest("[data-gift-slug]");
  try {
    await request(`/api/admin/gifts/${encodeURIComponent(form.dataset.giftSlug)}/status`, {
      method: "PATCH",
      body: { active: button.dataset.giftActive === "true" },
    });
    await refreshDashboard();
    setFeedback("礼物上架状态已更新。");
  } catch (error) {
    setFeedback(error.message);
  }
});

async function refreshDashboard() {
  const session = await request("/api/session");
  csrfToken = session.csrfToken;
  await loadDashboard(session.user);
}

document.querySelector("[data-admin-logout]").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST", body: {} });
    csrfToken = "";
    dashboard.hidden = true;
    loginPanel.hidden = false;
    document.querySelector("[data-admin-logout]").hidden = true;
    setFeedback("");
  } catch (error) {
    setFeedback(`退出失败：${error.message}`);
  }
});

request("/api/session")
  .then(async (session) => {
    csrfToken = session.csrfToken;
    await loadDashboard(session.user);
  })
  .catch((error) => {
    if (error.message !== "请先登录。") {
      document.querySelector("[data-admin-login-feedback]").textContent = error.message === "需要管理员权限。"
        ? "当前账户不是管理员，请使用管理员账户登录。"
        : `后端服务未连接：${error.message} 请从项目目录启动 server.rb。`;
    }
  });
