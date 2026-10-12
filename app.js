const poolRules = {
  1: { name: "初级池", nameKey: "pool.lv1", minimum: 10, balance: 100, duration: 60 },
  2: { name: "进阶池", nameKey: "pool.lv2", minimum: 50, balance: 600, duration: 120 },
  3: { name: "精英池", nameKey: "pool.lv3", minimum: 300, balance: 2000, duration: 180 },
  4: { name: "大师池", nameKey: "pool.lv4", minimum: 800, balance: 7000, duration: 240 },
  5: { name: "星环池", nameKey: "pool.lv5", minimum: 2000, balance: 20000, duration: 300 },
  6: { name: "深空池", nameKey: "pool.lv6", minimum: 5000, balance: 50000, duration: 360 },
  7: { name: "奇点池", nameKey: "pool.lv7", minimum: 10000, balance: 100000, duration: 420 },
  8: { name: "创世池", nameKey: "pool.lv8", minimum: 20000, balance: 200000, duration: 480 },
};

function poolName(rule) {
  return rule && rule.nameKey ? t(rule.nameKey) : (rule ? rule.name : "");
}

let csrfToken = "";
let authenticatedUsername = "";
let lastStateSyncAt = 0;
const apiPendingRounds = new Set();

async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let result = {};
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok) throw new Error(t("api.badPayload"));
  }
  if (!response.ok) throw new Error(result.error || t("api.requestFailed", { status: response.status }));
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}

const amountInput = document.querySelector("#mint-amount");
const amountFeedback = document.querySelector("[data-amount-feedback]");
const levelLabel = document.querySelector("[data-selected-level]");
const modal = document.querySelector("[data-modal]");
const toast = document.querySelector("[data-toast-box]");
const activityList = document.querySelector("[data-activity-list]");
const selected = { level: 1, method: 1 };
const wallet = {
  balance: 0,
  history: [],
  requests: [],
};
const walletModal = document.querySelector("[data-wallet-modal]");
const roundModal = document.querySelector("[data-round-modal]");
const poolRounds = Object.fromEntries(
  Array.from({ length: 8 }, (_, index) => {
    const level = index + 1;
    return [level, {
      endsAt: 0,
      completed: false,
      betAmount: 0,
      profitAmount: 0,
      won: null,
      method: 1,
      startedAt: 0,
      settled: true,
    }];
  }),
);
let walletMode = "deposit";
let walletOpener = null;
let toastTimeout;
let roundAnimationInterval;
const gifts = [
  { slug: "algorithmcup", name: "算法杯", english: "Algorithm Cups", category: "other" },
  { slug: "artisanbrick", name: "匠心砖", english: "Artisan Bricks", category: "other" },
  { slug: "astralshard", name: "星界碎片", english: "Astral Shards", category: "other" },
  { slug: "bdaycandle", name: "生日蜡烛", english: "B-Day Candles", category: "celebration" },
  { slug: "berrybox", name: "莓果礼盒", english: "Berry Boxes", category: "other" },
  { slug: "bigyear", name: "吉年", english: "Big Years", category: "celebration" },
  { slug: "blingbinky", name: "闪耀奶嘴", english: "Bling Binkies", category: "other" },
  { slug: "bondedring", name: "羁绊戒指", english: "Bonded Rings", category: "accessories" },
  { slug: "bowtie", name: "领结", english: "Bow Ties", category: "accessories" },
  { slug: "bunnymuffin", name: "兔子松饼", english: "Bunny Muffins", category: "animals" },
  { slug: "candycane", name: "拐杖糖", english: "Candy Canes", category: "celebration" },
  { slug: "chillflame", name: "冷焰", english: "Chill Flames", category: "other" },
  { slug: "cloverpin", name: "四叶草胸针", english: "Clover Pins", category: "accessories" },
  { slug: "cookieheart", name: "爱心饼干", english: "Cookie Hearts", category: "celebration" },
  { slug: "crystalball", name: "水晶球", english: "Crystal Balls", category: "other" },
  { slug: "cupidcharm", name: "丘比特吊坠", english: "Cupid Charms", category: "accessories" },
  { slug: "deskcalendar", name: "桌面日历", english: "Desk Calendars", category: "other" },
  { slug: "diamondring", name: "钻石戒指", english: "Diamond Rings", category: "accessories" },
  { slug: "durovscap", name: "杜罗夫帽", english: "Durov's Caps", category: "accessories" },
  { slug: "durovsglasses", name: "杜罗夫眼镜", english: "Durov's Glasses", category: "accessories" },
  { slug: "easteregg", name: "复活节彩蛋", english: "Easter Eggs", category: "celebration" },
  { slug: "electricskull", name: "电光骷髅", english: "Electric Skulls", category: "other" },
  { slug: "eternalcandle", name: "永恒蜡烛", english: "Eternal Candles", category: "celebration" },
  { slug: "eternalrose", name: "永恒玫瑰", english: "Eternal Roses", category: "flowers" },
];

const giftGrid = document.querySelector("[data-gift-grid]");
const giftSearch = document.querySelector("[data-gift-search]");
const giftSort = document.querySelector("[data-gift-sort]");
const giftDetail = document.querySelector("[data-gift-detail]");
const giftPageState = { filter: "all", category: "all", query: "", sort: "featured", limit: 8 };
let activeGift = null;
const holdings = [];
let holdingsFilter = "all";
const DEMO_COLLECTIBLE_VALUE = 10000;
const DEMO_RENTAL_DAILY_RATE = 0.01;
const DEMO_INTEREST_ANNUAL_RATE = 0.08;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function readFavoriteSlugs() {
  return new Set((localStorage.getItem("gram-gift-favorites") || "").split(",").filter(Boolean));
}

function writeFavoriteSlugs(favorites) {
  localStorage.setItem("gram-gift-favorites", [...favorites].join(","));
}

function createGiftCard(gift, index, favorites) {
  const card = document.createElement("article");
  card.className = `collectible-card collectible-${(index % 4) + 1}`;
  card.dataset.giftSlug = gift.slug;

  const preview = document.createElement("button");
  preview.className = "collectible-art gift-image-link";
  preview.type = "button";
  preview.dataset.giftOpen = gift.slug;
  preview.setAttribute("aria-label", t("gift.viewDetail", { name: gift.english }));

  const image = document.createElement("img");
  image.src = `https://fragment.com/file/gifts/${gift.slug}/thumb.webp`;
  image.alt = t("gift.altMain", { name: gift.english });
  image.loading = index < 4 ? "eager" : "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    preview.classList.add("image-unavailable");
    image.alt = t("gift.altError", { name: gift.english });
  }, { once: true });

  const serial = document.createElement("small");
  serial.textContent = `GIFT · ${String(gifts.indexOf(gift) + 1).padStart(2, "0")}`;
  preview.append(image, serial);

  const info = document.createElement("button");
  info.className = "collectible-info";
  info.type = "button";
  info.dataset.giftOpen = gift.slug;
  const name = document.createElement("strong");
  name.textContent = gift.name;
  const english = document.createElement("span");
  english.textContent = gift.english;
  info.append(name, english);

  const favorite = document.createElement("button");
  favorite.className = "collectible-favorite";
  favorite.type = "button";
  favorite.dataset.giftFavorite = gift.slug;
  favorite.setAttribute("aria-pressed", String(favorites.has(gift.slug)));
  favorite.setAttribute("aria-label", favorites.has(gift.slug) ? t("gift.favRemoveAria", { name: gift.english }) : t("gift.favAddAria", { name: gift.english }));
  favorite.textContent = favorites.has(gift.slug) ? "♥" : "♡";

  const source = document.createElement("a");
  source.className = "collectible-tag";
  source.href = `https://fragment.com/gifts/${gift.slug}`;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.textContent = "Fragment ↗";
  card.append(preview, info, favorite, source);
  return card;
}

function getVisibleGifts() {
  const favorites = readFavoriteSlugs();
  const query = giftPageState.query.trim().toLocaleLowerCase();
  let result = gifts.filter((gift) => {
    const matchesQuery = !query || `${gift.name} ${gift.english} ${gift.slug}`.toLocaleLowerCase().includes(query);
    const matchesCategory = giftPageState.category === "all" || gift.category === giftPageState.category;
    const matchesFavorite = giftPageState.filter !== "favorites" || favorites.has(gift.slug);
    return matchesQuery && matchesCategory && matchesFavorite;
  });

  if (giftPageState.sort === "name-asc") result = [...result].sort((a, b) => a.english.localeCompare(b.english));
  if (giftPageState.sort === "name-desc") result = [...result].sort((a, b) => b.english.localeCompare(a.english));
  return result;
}

function renderGifts() {
  if (!giftGrid) return;
  const favorites = readFavoriteSlugs();
  const matchingGifts = getVisibleGifts();
  const displayedGifts = matchingGifts.slice(0, giftPageState.limit);
  giftGrid.replaceChildren(...displayedGifts.map((gift) => createGiftCard(gift, gifts.indexOf(gift), favorites)));

  document.querySelector("[data-all-count]").textContent = String(gifts.length);
  document.querySelector("[data-favorite-count]").textContent = String(favorites.size);
  document.querySelector("[data-gift-result]").textContent =
    t("gift.showCount", { shown: displayedGifts.length, total: matchingGifts.length });
  document.querySelector("[data-gift-empty]").hidden = matchingGifts.length > 0;
  document.querySelector("[data-load-more]").hidden = displayedGifts.length >= matchingGifts.length;
}

function setGiftFilter(filter) {
  giftPageState.filter = filter;
  giftPageState.limit = 8;
  document.querySelectorAll("[data-gift-filter]").forEach((button) => {
    const active = button.dataset.giftFilter === filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderGifts();
}

function toggleFavorite(slug) {
  const favorites = readFavoriteSlugs();
  const isFavorite = favorites.has(slug);
  if (isFavorite) favorites.delete(slug);
  else favorites.add(slug);
  writeFavoriteSlugs(favorites);
  renderGifts();
  if (activeGift?.slug === slug) updateGiftDetailFavorite();
  showToast(isFavorite ? t("dyn.favoriteRemove") : t("dyn.favoriteAdd"));
}

function updateGiftDetailFavorite() {
  if (!activeGift) return;
  const isFavorite = readFavoriteSlugs().has(activeGift.slug);
  const button = document.querySelector("[data-detail-favorite]");
  button.textContent = isFavorite ? t("gift.favAddedLabel") : t("gd.favorite");
  button.setAttribute("aria-pressed", String(isFavorite));
}

function updateGiftDetailAddButton() {
  if (!activeGift) return;
  const count = holdings.filter((item) => item.slug === activeGift.slug).length;
  document.querySelector("[data-detail-add]").textContent =
    count > 0 ? t("gd.readd", { count }) : t("gd.add");
}

function openGiftDetail(slug) {
  activeGift = gifts.find((gift) => gift.slug === slug) || null;
  if (!activeGift) return;

  const image = giftDetail.querySelector("[data-detail-image]");
  image.src = `https://fragment.com/file/gifts/${activeGift.slug}/thumb.webp`;
  image.alt = t("gift.altTelegram", { name: activeGift.english });
  giftDetail.querySelector("[data-detail-title]").textContent = `${activeGift.name} · ${activeGift.english}`;
  giftDetail.querySelector("[data-detail-description]").textContent =
    t("gift.detailDesc");
  giftDetail.querySelector("[data-detail-source]").href = `https://fragment.com/gifts/${activeGift.slug}`;
  updateGiftDetailFavorite();
  updateGiftDetailAddButton();
  giftDetail.classList.add("is-open");
  giftDetail.setAttribute("aria-hidden", "false");
  giftDetail.querySelector("[data-gift-detail-close]").focus();
}

function closeGiftDetail() {
  giftDetail.classList.remove("is-open");
  giftDetail.setAttribute("aria-hidden", "true");
  activeGift = null;
}

function saveHoldings() {
  return undefined;
}

function getHoldingEarnings(item, now = Date.now()) {
  if (item.status === "owned" || item.startedAt <= 0) return item.earnedUnits;
  const elapsed = Math.max(0, now - item.startedAt);
  const rate = item.status === "rental"
    ? DEMO_RENTAL_DAILY_RATE / DAY_IN_MS
    : DEMO_INTEREST_ANNUAL_RATE / (365 * DAY_IN_MS);
  return item.earnedUnits + Math.floor(DEMO_COLLECTIBLE_VALUE * rate * elapsed);
}

function createHoldingCard(item, index, now) {
  const gift = gifts.find((entry) => entry.slug === item.slug);
  const card = document.createElement("article");
  card.className = `collectible-card holding-card collectible-${(index % 4) + 1}`;
  card.dataset.holdingId = item.id;

  const art = document.createElement("div");
  art.className = "collectible-art holding-art";
  const image = document.createElement("img");
  image.src = `https://fragment.com/file/gifts/${gift.slug}/thumb.webp`;
  image.alt = t("gift.altFigure", { name: gift.english });
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    art.classList.add("image-unavailable");
    image.alt = t("gift.altError", { name: gift.english });
  }, { once: true });
  const badge = document.createElement("small");
  badge.className = `holding-status ${item.status}`;
  badge.textContent = item.status === "rental" ? t("hold.rental") : item.status === "interest" ? t("hold.interest") : t("coll.myItem");
  art.append(image, badge);

  const info = document.createElement("div");
  info.className = "holding-card-info";
  const title = document.createElement("strong");
  title.textContent = gift.name;
  const subtitle = document.createElement("span");
  subtitle.textContent = `${gift.english} · ${t("coll.valuation")}`;
  const earnings = document.createElement("div");
  earnings.className = "holding-earnings";
  const earningsLabel = document.createElement("span");
  earningsLabel.textContent = t("coll.claimable");
  const earningsAmount = document.createElement("strong");
  earningsAmount.textContent = `${formatGram(getHoldingEarnings(item, now))} G`;
  earnings.append(earningsLabel, earningsAmount);
  info.append(title, subtitle, earnings);

  const actions = document.createElement("div");
  actions.className = "holding-actions";
  const addAction = (action, label, className) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.holdingAction = action;
    button.dataset.holdingId = item.id;
    button.className = className;
    button.textContent = label;
    actions.append(button);
  };
  if (item.status === "owned") {
    addAction("rental", t("coll.rentalRate"), "holding-action-primary");
    addAction("interest", t("coll.interestRate"), "holding-action-secondary");
  } else {
    addAction("stop", t("coll.stopAction"), "holding-action-secondary");
  }

  card.append(art, info, actions);
  return card;
}

function renderMyCollection() {
  const grid = document.querySelector("[data-holdings-grid]");
  if (!grid) return;
  const now = Date.now();
  const visibleHoldings = holdingsFilter === "all"
    ? holdings
    : holdings.filter((item) => item.status === holdingsFilter);
  const totalEarnings = holdings.reduce((sum, item) => sum + getHoldingEarnings(item, now), 0);
  const rentedCount = holdings.filter((item) => item.status === "rental").length;
  const interestCount = holdings.filter((item) => item.status === "interest").length;
  const claimButton = document.querySelector("[data-claim-earnings]");

  document.querySelector("[data-holding-count]").textContent = t("coll.countUnit", { count: holdings.length });
  document.querySelector("[data-rented-count]").textContent = t("coll.countUnit", { count: rentedCount });
  document.querySelector("[data-interest-count]").textContent = t("coll.countUnit", { count: interestCount });
  document.querySelector("[data-profile-holding-count]").textContent = t("coll.countUnit", { count: holdings.length });
  document.querySelector("[data-claimable-amount]").textContent = formatGram(totalEarnings);
  claimButton.disabled = totalEarnings <= 0;
  const emptyState = document.querySelector("[data-holdings-empty]");
  emptyState.hidden = visibleHoldings.length > 0;
  if (holdings.length === 0) {
    emptyState.querySelector("strong").textContent = t("coll.emptyTitle");
    emptyState.querySelector("p").textContent = t("coll.emptyDesc");
  } else if (visibleHoldings.length === 0) {
    emptyState.querySelector("strong").textContent = t("coll.emptyCategory");
    emptyState.querySelector("p").textContent = t("coll.emptyFiltered");
  }
  grid.hidden = visibleHoldings.length === 0;
  grid.replaceChildren(...visibleHoldings.map((item, index) => createHoldingCard(item, index, now)));
}

function refreshMyCollectionEarnings() {
  const now = Date.now();
  const totalEarnings = holdings.reduce((sum, item) => sum + getHoldingEarnings(item, now), 0);
  document.querySelector("[data-claimable-amount]").textContent = formatGram(totalEarnings);
  document.querySelector("[data-claim-earnings]").disabled = totalEarnings <= 0;
  document.querySelectorAll(".holding-card").forEach((card) => {
    const item = holdings.find((holding) => holding.id === card.dataset.holdingId);
    const amount = card.querySelector(".holding-earnings strong");
    if (item && amount) amount.textContent = `${formatGram(getHoldingEarnings(item, now))} G`;
  });
}

function addActiveGiftToCollection() {
  if (!activeGift) return;
  apiRequest("/api/holdings", { method: "POST", body: { slug: activeGift.slug } })
    .then((result) => {
      applyServerState(result.state);
      showToast(t("dyn.addedToCollection"));
      updateGiftDetailAddButton();
    })
    .catch((error) => showToast(error.message));
}

function updateHoldingMode(id, mode) {
  const item = holdings.find((holding) => holding.id === id);
  if (!item) return;
  const status = mode === "stop" ? "owned" : mode;
  apiRequest(`/api/holdings/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } })
    .then((state) => {
      applyServerState(state);
      showToast(status === "owned" ? t("dyn.stoppedOwned") : status === "rental" ? t("dyn.startedRental") : t("dyn.startedInterest"));
    })
    .catch((error) => showToast(error.message));
}

function claimCollectionEarnings() {
  apiRequest("/api/holdings/claim", { method: "POST", body: {} })
    .then((state) => {
      applyServerState(state);
      showToast(t("dyn.claimed", { amount: formatGram(state.claimedUnits) }));
    })
    .catch((error) => showToast(error.message));
}

function renderInvitation(user) {
  const chip = document.querySelector("[data-invitation-card]");
  const codeLabel = document.querySelector("[data-invitation-code]");
  if (!chip || !codeLabel) return;
  const code = user && user.invitationCode ? String(user.invitationCode).toUpperCase() : "";
  chip.hidden = !code;
  codeLabel.textContent = code || "•••••";
}

async function copyInvitationCode() {
  const codeLabel = document.querySelector("[data-invitation-code]");
  const code = codeLabel ? codeLabel.textContent : "";
  if (!code || code === "•••••") return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const helper = document.createElement("textarea");
      helper.value = code;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    showToast(t("prof.invitationCopied", { code }));
  } catch (error) {
    showToast(t("prof.invitationCopied", { code }));
  }
}

document.querySelector("[data-invitation-copy]")?.addEventListener("click", copyInvitationCode);

function applyServerState(state) {
  wallet.balance = state.user.balanceUnits;
  wallet.history = state.walletHistory;
  depositAddresses = Array.isArray(state.depositAddresses) ? state.depositAddresses : [];
  if (depositAddresses.length === 0) {
    selectedDepositAddressId = null;
  } else if (!depositAddresses.some((entry) => entry.id === selectedDepositAddressId)) {
    [selectedDepositAddressId] = depositAddresses.map((entry) => entry.id);
  }
  wallet.requests = state.walletRequests || [];
  holdings.splice(0, holdings.length, ...state.holdings);
  gifts.splice(0, gifts.length, ...state.gifts);
  state.holdings.forEach((item) => {
    if (!gifts.some((gift) => gift.slug === item.slug)) {
      gifts.push({ slug: item.slug, name: item.itemName || item.slug, english: item.english || item.slug, category: "other", active: false });
    }
  });
  csrfToken = state.csrfToken;

  state.poolRules.forEach((rule) => {
    Object.assign(poolRules[rule.level], {
      minimum: rule.minimumUnits / 100,
      balance: rule.entryUnits / 100,
      duration: rule.duration,
      profitPercent: rule.profitPercent,
      winProbabilityBp: rule.winProbabilityBp,
      enabled: rule.enabled,
    });
  });

  Object.keys(poolRounds).forEach((level) => {
    const round = state.rounds.find((entry) => entry.level === Number(level));
    Object.assign(poolRounds[level], round ? {
      id: round.id,
      endsAt: round.endsAt,
      completed: round.completed,
      settled: round.settled,
      betAmount: round.betAmount,
      profitAmount: round.profitAmount || 0,
      won: round.won,
      method: round.method,
      startedAt: round.startedAt,
      winProbabilityBp: round.winProbabilityBp,
      profitPercent: round.profitPercent,
      fairnessCommitment: round.fairnessCommitment,
      fairnessSecret: round.fairnessSecret,
      fairnessNonce: round.fairnessNonce,
      fairnessDraw: round.fairnessDraw,
    } : {
      id: null,
      endsAt: 0,
      completed: false,
      settled: true,
      betAmount: 0,
      profitAmount: 0,
      won: null,
      method: 1,
      startedAt: 0,
      winProbabilityBp: poolRules[level].winProbabilityBp,
      profitPercent: poolRules[level].profitPercent,
      fairnessCommitment: null,
      fairnessSecret: null,
      fairnessNonce: null,
    });
  });

  if (state.user.role === "admin") {
    document.querySelector("[data-admin-entry]").hidden = false;
  } else if (state.user.role === "agent") {
    document.querySelector("[data-admin-entry]").hidden = false;
  } else {
    document.querySelector("[data-admin-entry]").hidden = true;
  }

  renderInvitation(state.user);
  renderGifts();
  renderWallet();
  activityList.replaceChildren();
  renderSavedRoundActivity();
}

async function refreshServerState() {
  const state = await apiRequest("/api/state");
  applyServerState(state);
  lastStateSyncAt = Date.now();
  return state;
}

/* ============ TON 行情图（真实数据源 + 本地兜底） ============ */
/* 数据源按顺序尝试：CoinGecko → Binance → 本地模拟序列。
   前两者均为免费公开行情接口，无需 API Key 且对浏览器开放跨域(CORS)访问；
   任一源请求失败、超时或返回异常数据时自动降级到下一个源，全部失败时使用本地序列，
   并在右上角标签中显示当前数据来源（实时 / 演示），页面不会白屏。 */
const CHART_SOURCES = [
  {
    id: "coingecko",
    liveLabel: "coingecko",
    buildUrl: (range) => {
      const days = range === "24H" ? 1 : range === "7D" ? 7 : 30;
      return `https://api.coingecko.com/api/v3/coins/the-open-network/market_chart?vs_currency=usd&days=${days}`;
    },
    parse: (payload) => {
      if (!payload || !Array.isArray(payload.prices)) return null;
      const volumes = Array.isArray(payload.total_volumes) ? payload.total_volumes : [];
      return payload.prices
        .map((point, index) => ({
          time: Number(point[0]),
          price: Number(point[1]),
          volume: volumes[index] ? Number(volumes[index][1]) : 0,
        }))
        .filter((point) => point.time > 0 && point.price > 0);
    },
  },
  {
    id: "binance",
    liveLabel: "binance",
    buildUrl: (range) => {
      const plan = {
        "24H": { interval: "15m", limit: 96 },
        "7D": { interval: "2h", limit: 84 },
        "30D": { interval: "8h", limit: 90 },
      }[range];
      return `https://api.binance.com/api/v3/klines?symbol=TONUSDT&interval=${plan.interval}&limit=${plan.limit}`;
    },
    parse: (payload) => {
      if (!Array.isArray(payload)) return null;
      return payload
        .map((row) => ({
          time: Number(row[0]),
          price: Number(row[4]),
          volume: Number(row[7]),
        }))
        .filter((point) => point.time > 0 && point.price > 0);
    },
  },
];
const CHART_REQUEST_TIMEOUT = 9000;
const CHART_POLL_INTERVAL = 25000;
const CHART_BASE_PRICE = 2.35;
const CHART_RANGES = {
  "24H": { points: 72, stepMs: 20 * 60 * 1000, volatility: 0.0013, volume: 428.6, ma: 7 },
  "7D": { points: 84, stepMs: 2 * 60 * 60 * 1000, volatility: 0.0028, volume: 2913.4, ma: 7 },
  "30D": { points: 90, stepMs: 8 * 60 * 60 * 1000, volatility: 0.0042, volume: 12480.7, ma: 7 },
};
const CHART_GEOMETRY = { width: 320, top: 14, bottom: 104, volumeTop: 112, volumeBottom: 142 };
const chartState = { range: "24H", series: [], source: null };
const chartCache = new Map();

function seededRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    return value / 0x7fffffff;
  };
}

function buildChartSeries(range) {
  const config = CHART_RANGES[range];
  const seed = range.split("").reduce((total, char) => total + char.charCodeAt(0), 7) * 31;
  const random = seededRandom(seed);
  const drift = (random() - 0.42) * config.volatility * config.points * 0.5;
  let price = CHART_BASE_PRICE * (1 - drift * 0.5);
  const series = [];
  const now = Date.now();
  for (let index = 0; index < config.points; index += 1) {
    const wave = Math.sin(index / config.points * Math.PI * 2.2) * config.volatility * 6;
    const shock = (random() - 0.5) * config.volatility * 9;
    price = price * (1 + wave * 0.16 + shock);
    price = Math.max(price, CHART_BASE_PRICE * 0.72);
    const baseVolume = config.volume / config.points;
    series.push({
      time: now - (config.points - 1 - index) * config.stepMs,
      price: Number(price.toFixed(2)),
      volume: Number((baseVolume * (0.55 + random() * 0.9)).toFixed(1)),
    });
  }
  series[series.length - 1].price = Number(CHART_BASE_PRICE.toFixed(2));
  return series;
}

async function fetchRemoteSeries(range, force = false) {
  if (!force && chartCache.has(range)) return chartCache.get(range);
  for (const source of CHART_SOURCES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHART_REQUEST_TIMEOUT);
      const response = await fetch(source.buildUrl(range), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const series = source.parse(await response.json());
      if (series && series.length > 4) {
        const payload = { series, source: source.id };
        chartCache.set(range, payload);
        return payload;
      }
    } catch (error) {
      // 跨域被拦截、超时或网络不可用时继续尝试下一个数据源
    }
  }
  return null;
}

async function resolveChartSeries(range, force = false) {
  const remote = await fetchRemoteSeries(range, force);
  if (remote) return remote;
  return { series: buildChartSeries(range), source: "local" };
}

function formatChartPrice(value) {
  const digits = Math.abs(value) < 10 ? 4 : 2;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatChartVolume(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(1)}`;
}

const CHART_SOURCE_LABELS = {
  coingecko: "CoinGecko 实时",
  binance: "Binance 实时",
  local: "演示数据",
};

function renderChartSource() {
  const pill = document.querySelector("[data-chart-source]");
  if (!pill) return;
  if (!chartState.source) {
    pill.dataset.state = "loading";
    const loadingLabel = pill.querySelector("span");
    if (loadingLabel) loadingLabel.textContent = t("chart.loading");
    pill.title = t("chart.liveTitle");
    return;
  }
  const isLocal = chartState.source === "local";
  pill.dataset.state = isLocal ? "demo" : "live";
  const label = pill.querySelector("span");
  if (label) label.textContent = CHART_SOURCE_LABELS[chartState.source] || t("chart.loading");
  pill.title = isLocal ? t("chart.demoTitle") : t("chart.liveTitle");
}

function chartPointLabel(range, timestamp) {
  const date = new Date(timestamp);
  if (range === "24H") {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function movingAverage(series, window) {
  return series.map((point, index) => {
    const start = Math.max(0, index - window + 1);
    const slice = series.slice(start, index + 1);
    const total = slice.reduce((sum, entry) => sum + entry.price, 0);
    return { ...point, price: Number((total / slice.length).toFixed(2)) };
  });
}

function seriesToPath(points, toX, toY) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${toX(point, index).toFixed(2)} ${toY(point.price).toFixed(2)}`)
    .join(" ");
}

function renderMarketChart() {
  const figure = document.querySelector("[data-chart-figure]");
  const svg = figure?.querySelector(".market-chart-svg");
  if (!figure || !svg) return;
  const labels = {
    price: document.querySelector("[data-chart-price]"),
    change: document.querySelector("[data-chart-change]"),
    open: document.querySelector("[data-chart-open]"),
    high: document.querySelector("[data-chart-high]"),
    low: document.querySelector("[data-chart-low]"),
    volume: document.querySelector("[data-chart-volume]"),
    axisTop: document.querySelector("[data-chart-axis-top]"),
    axisMid: document.querySelector("[data-chart-axis-mid]"),
    axisBottom: document.querySelector("[data-chart-axis-bottom]"),
    timeStart: document.querySelector("[data-chart-time-start]"),
    timeMid: document.querySelector("[data-chart-time-mid]"),
    timeEnd: document.querySelector("[data-chart-time-end]"),
  };
  if (!labels.price || !labels.change || !labels.open) return;

  const series = chartState.series;
  if (!series.length) return;
  const config = CHART_RANGES[chartState.range];
  const prices = series.map((point) => point.price);
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  const span = highest - lowest || 1;
  const { width, top, bottom, volumeTop, volumeBottom } = CHART_GEOMETRY;
  const stepX = width / (series.length - 1);
  const toX = (point, index) => index * stepX;
  const toY = (value) => bottom - ((value - lowest) / span) * (bottom - top);

  const linePath = seriesToPath(series, toX, toY);
  const areaPath = `${linePath} L${width} ${bottom} L0 ${bottom} Z`;
  const maSeries = movingAverage(series, config.ma);
  const maPath = seriesToPath(maSeries, toX, toY);

  svg.querySelector("[data-chart-area]").setAttribute("d", areaPath);
  svg.querySelector("[data-chart-line]").setAttribute("d", linePath);
  svg.querySelector("[data-chart-ma]").setAttribute("d", maPath);

  const volumes = series.map((point) => point.volume);
  const maxVolume = Math.max(...volumes, 1);
  const barWidth = Math.max(stepX * 0.55, 1.4);
  svg.querySelector("[data-chart-volumes]").innerHTML = series
    .map((point, index) => {
      const barHeight = Math.max((point.volume / maxVolume) * (volumeBottom - volumeTop), 1);
      const x = Number((index * stepX - barWidth / 2).toFixed(2));
      return `<rect x="${x}" y="${(volumeBottom - barHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="0.8" fill="url(#gram-chart-volume)" />`;
    })
    .join("");

  const latest = series[series.length - 1];
  const opening = series[0].price;
  const changePercent = ((latest.price - opening) / opening) * 100;
  const totalVolume = series.reduce((sum, point) => sum + point.volume, 0);

  labels.price.textContent = formatChartPrice(latest.price);
  labels.price.dataset.price = formatChartPrice(latest.price);
  labels.change.textContent = `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`;
  labels.change.classList.toggle("is-down", changePercent < 0);
  labels.open.textContent = formatChartPrice(opening);
  labels.high.textContent = formatChartPrice(highest);
  labels.low.textContent = formatChartPrice(lowest);
  labels.volume.textContent = formatChartVolume(totalVolume);
  labels.axisTop.textContent = formatChartPrice(highest);
  labels.axisMid.textContent = formatChartPrice((highest + lowest) / 2);
  labels.axisBottom.textContent = formatChartPrice(lowest);
  labels.timeStart.textContent = chartPointLabel(chartState.range, series[0].time);
  labels.timeMid.textContent = chartPointLabel(chartState.range, series[Math.floor(series.length / 2)].time);
  labels.timeEnd.textContent = chartPointLabel(chartState.range, latest.time);
}

function chartIsVisible() {
  return Boolean(document.querySelector('[data-page-panel="mint"]')?.classList.contains("is-visible"));
}

function updateChartHover(event) {
  const figure = document.querySelector("[data-chart-figure]");
  const tip = document.querySelector("[data-chart-tip]");
  if (!figure || !tip) return;
  const rect = figure.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const series = chartState.series;
  const index = Math.round(ratio * (series.length - 1));
  const point = series[index];
  const prices = series.map((entry) => entry.price);
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  const span = highest - lowest || 1;
  const { width, top, bottom } = CHART_GEOMETRY;
  const x = Number((index * (width / (series.length - 1))).toFixed(2));
  const y = Number((bottom - ((point.price - lowest) / span) * (bottom - top)).toFixed(2));

  figure.classList.add("is-active");
  figure.querySelector("[data-chart-cursor]").setAttribute("x1", String(x));
  figure.querySelector("[data-chart-cursor]").setAttribute("x2", String(x));
  figure.querySelector("[data-chart-dot]").setAttribute("cx", String(x));
  figure.querySelector("[data-chart-dot]").setAttribute("cy", String(y));

  tip.hidden = false;
  tip.innerHTML = `<strong>${formatChartPrice(point.price)}</strong><span>${chartPointLabel(chartState.range, point.time)} · ${formatChartVolume(point.volume)}</span>`;
  const tipWidth = tip.offsetWidth || 96;
  const left = Math.min(Math.max((x / width) * rect.width, tipWidth / 2 + 4), rect.width - tipWidth / 2 - 4);
  tip.style.left = `${left}px`;
}

function hideChartHover() {
  const figure = document.querySelector("[data-chart-figure]");
  const tip = document.querySelector("[data-chart-tip]");
  if (figure) figure.classList.remove("is-active");
  if (tip) tip.hidden = true;
}

async function switchChartRange(range) {
  if (!CHART_RANGES[range]) return;
  chartState.range = range;
  document.querySelectorAll("[data-chart-range]").forEach((button) => {
    const isActive = button.dataset.chartRange === range;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  hideChartHover();
  const resolved = await resolveChartSeries(range);
  chartState.series = resolved.series;
  chartState.source = resolved.source;
  renderChartSource();
  renderMarketChart();
}

function initMarketChart() {
  const figure = document.querySelector("[data-chart-figure]");
  if (!figure) return;
  chartState.series = buildChartSeries(chartState.range);
  chartState.source = null;
  renderChartSource();
  renderMarketChart();

  document.querySelectorAll("[data-chart-range]").forEach((button) => {
    button.addEventListener("click", () => switchChartRange(button.dataset.chartRange));
  });
  figure.addEventListener("pointermove", updateChartHover);
  figure.addEventListener("pointerdown", updateChartHover);
  figure.addEventListener("pointerleave", hideChartHover);
  figure.addEventListener("pointercancel", hideChartHover);

  /* 首次加载拉取真实行情；失败则继续展示本地序列 */
  resolveChartSeries(chartState.range).then((resolved) => {
    chartState.series = resolved.series;
    chartState.source = resolved.source;
    renderChartSource();
    renderMarketChart();
  });

  /* 演示数据模式下模拟价格跳动 */
  setInterval(() => {
    if (!chartIsVisible() || chartState.source !== "local") return;
    const series = chartState.series;
    if (!series.length) return;
    const last = series[series.length - 1];
    const jitter = (Math.random() - 0.5) * CHART_BASE_PRICE * 0.0016;
    last.price = Number(Math.max(last.price + jitter, CHART_BASE_PRICE * 0.7).toFixed(4));
    last.volume = Number(Math.max(last.volume * (0.9 + Math.random() * 0.25), 1).toFixed(1));
    renderMarketChart();
    hideChartHover();
  }, 4000);

  /* 真实行情模式下周期性刷新（拉取后写入缓存再读取，尊重接口频率限制） */
  setInterval(() => {
    if (!chartIsVisible() || chartState.source === "local") return;
    resolveChartSeries(chartState.range, true).then((resolved) => {
      if (resolved.source === "local") return;
      chartState.series = resolved.series;
      chartState.source = resolved.source;
      renderChartSource();
      renderMarketChart();
    });
  }, CHART_POLL_INTERVAL);
}

initMarketChart();

renderGifts();
renderMyCollection();

function setTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-label", isLight ? t("top.themeToDark") : t("top.themeToLight"));
    button.setAttribute("aria-pressed", String(isLight));
    const label = button.querySelector("[data-theme-name]");
    if (label) label.textContent = isLight ? t("prof.themeLight") : t("prof.themeDark");
  });
  document.querySelector('meta[name="theme-color"]').content = isLight ? "#f2f4fa" : "#080b17";
}

function setPage(page) {
  const panel = document.querySelector(`[data-page-panel="${page}"]`);
  if (!panel) return;

  document.querySelectorAll("[data-page-panel]").forEach((pagePanel) => {
    const isActive = pagePanel === panel;
    pagePanel.hidden = !isActive;
    pagePanel.classList.toggle("is-visible", isActive);
  });

  document.querySelectorAll(".nav-item[data-page-link]").forEach((navItem) => {
    const isActive = navItem.dataset.pageLink === page;
    navItem.classList.toggle("is-active", isActive);
    navItem.setAttribute("aria-current", isActive ? "page" : "false");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const savedTheme = localStorage.getItem("gram-theme");
setTheme(savedTheme === "light" ? "light" : "dark");

document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("gram-theme", nextTheme);
    setTheme(nextTheme);
  });
});

document.querySelectorAll("[data-page-link]").forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.pageLink));
});

const languageModal = document.querySelector("[data-language-modal]");
const languageOptions = document.querySelector("[data-language-options]");
const currentLanguageLabel = document.querySelector("[data-current-language]");

function languageInfo(code) {
  return LANGUAGES.find((item) => item.code === code) || LANGUAGES[0];
}

function updateCurrentLanguageLabel() {
  if (!currentLanguageLabel) return;
  const info = languageInfo(getLanguage());
  currentLanguageLabel.textContent = `${info.native}　›`;
}

function renderLanguageOptions() {
  if (!languageOptions) return;
  const active = getLanguage();
  languageOptions.replaceChildren(
    ...LANGUAGES.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "language-option" + (item.code === active ? " is-active" : "");
      button.setAttribute("aria-pressed", String(item.code === active));
      const flag = document.createElement("span");
      flag.className = "language-option-flag";
      flag.textContent = item.flag;
      const copy = document.createElement("span");
      copy.className = "language-option-copy";
      const native = document.createElement("strong");
      native.textContent = item.native;
      const label = document.createElement("small");
      label.textContent = item.label;
      copy.append(native, label);
      const check = document.createElement("span");
      check.className = "language-option-check";
      check.textContent = "✓";
      button.append(flag, copy, check);
      button.addEventListener("click", () => {
        setLanguage(item.code);
        updateCurrentLanguageLabel();
        closeLanguageModal();
        refreshLocalizedUI();
      });
      return button;
    })
  );
}

function refreshLocalizedUI() {
  setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  renderPoolStates();
  syncSelectedPoolUI();
  updateAmountFeedback();
  renderWallet();
  renderWalletHistory();
  renderMyCollection();
  renderGifts();
  renderSavedRoundActivity();
  if (activeGift) {
    updateGiftDetailFavorite();
    updateGiftDetailAddButton();
  }
  if (walletModal.classList.contains("is-open")) setWalletMode(walletMode);
  if (roundModal.classList.contains("is-open")) {
    const level = Number(roundModal.dataset.roundLevel);
    const round = poolRounds[level];
    if (round?.completed) showRoundResult(level);
    else renderRoundExperience();
  }
}

function openLanguageModal() {
  renderLanguageOptions();
  languageModal.classList.add("is-open");
  languageModal.setAttribute("aria-hidden", "false");
  languageOptions?.querySelector(".language-option.is-active")?.focus();
}

function closeLanguageModal() {
  languageModal.classList.remove("is-open");
  languageModal.setAttribute("aria-hidden", "true");
}

document.querySelectorAll("[data-language-open]").forEach((trigger) => {
  trigger.addEventListener("click", openLanguageModal);
});
document.querySelectorAll("[data-language-close]").forEach((button) => {
  button.addEventListener("click", closeLanguageModal);
});
languageModal.addEventListener("click", (event) => {
  if (event.target === languageModal) closeLanguageModal();
});
updateCurrentLanguageLabel();

giftSearch.addEventListener("input", () => {
  giftPageState.query = giftSearch.value;
  giftPageState.limit = 8;
  document.querySelector("[data-clear-search]").hidden = giftSearch.value.length === 0;
  renderGifts();
});

document.querySelector("[data-clear-search]").addEventListener("click", () => {
  giftSearch.value = "";
  giftPageState.query = "";
  document.querySelector("[data-clear-search]").hidden = true;
  renderGifts();
  giftSearch.focus();
});

document.querySelectorAll("[data-gift-filter]").forEach((button) => {
  button.addEventListener("click", () => setGiftFilter(button.dataset.giftFilter));
});

document.querySelectorAll("[data-gift-category]").forEach((button) => {
  button.addEventListener("click", () => {
    giftPageState.category = button.dataset.giftCategory;
    giftPageState.limit = 8;
    document.querySelectorAll("[data-gift-category]").forEach((categoryButton) => {
      const active = categoryButton === button;
      categoryButton.classList.toggle("is-active", active);
      categoryButton.setAttribute("aria-pressed", String(active));
    });
    renderGifts();
  });
});

giftSort.addEventListener("change", () => {
  giftPageState.sort = giftSort.value;
  giftPageState.limit = 8;
  renderGifts();
});

document.querySelector("[data-load-more]").addEventListener("click", () => {
  giftPageState.limit += 8;
  renderGifts();
});

document.querySelector("[data-reset-gifts]").addEventListener("click", () => {
  giftSearch.value = "";
  giftPageState.query = "";
  giftPageState.category = "all";
  giftPageState.filter = "all";
  giftPageState.sort = "featured";
  giftPageState.limit = 8;
  giftSort.value = "featured";
  document.querySelector("[data-clear-search]").hidden = true;
  document.querySelectorAll("[data-gift-category]").forEach((button) => {
    const active = button.dataset.giftCategory === "all";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  setGiftFilter("all");
  giftSearch.focus();
});

giftGrid.addEventListener("click", (event) => {
  const favoriteButton = event.target.closest("[data-gift-favorite]");
  if (favoriteButton) {
    toggleFavorite(favoriteButton.dataset.giftFavorite);
    return;
  }

  const openButton = event.target.closest("[data-gift-open]");
  if (openButton) openGiftDetail(openButton.dataset.giftOpen);
});

document.querySelector("[data-detail-favorite]").addEventListener("click", () => {
  if (activeGift) toggleFavorite(activeGift.slug);
});

document.querySelector("[data-detail-add]").addEventListener("click", () => {
  addActiveGiftToCollection();
  updateGiftDetailAddButton();
});

document.querySelectorAll("[data-holding-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    holdingsFilter = button.dataset.holdingFilter;
    document.querySelectorAll("[data-holding-filter]").forEach((filterButton) => {
      const active = filterButton === button;
      filterButton.classList.toggle("is-active", active);
      filterButton.setAttribute("aria-pressed", String(active));
    });
    renderMyCollection();
  });
});

document.querySelector("[data-holdings-grid]").addEventListener("click", (event) => {
  const button = event.target.closest("[data-holding-action]");
  if (button) updateHoldingMode(button.dataset.holdingId, button.dataset.holdingAction);
});

document.querySelector("[data-claim-earnings]").addEventListener("click", claimCollectionEarnings);
setInterval(refreshMyCollectionEarnings, 1000);

document.querySelectorAll("[data-gift-detail-close]").forEach((button) => {
  button.addEventListener("click", closeGiftDetail);
});

giftDetail.addEventListener("click", (event) => {
  if (event.target === giftDetail) closeGiftDetail();
});

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function formatGram(units) {
  return (units / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function parseGramInput(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const units = Math.round(amount * 100);
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

function saveWallet() {
  return undefined;
}

function getReservedBalance() {
  return Object.values(poolRounds).reduce((total, round) => {
    return total + (round.endsAt > 0 && !round.settled ? round.betAmount : 0);
  }, 0);
}

/* ============ 充值地址与二维码 ============ */
let depositAddresses = [];
let selectedDepositAddressId = null;

function depositQrUrl(address) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(address)}`;
}

function renderDepositAddresses() {
  const list = document.querySelector("[data-deposit-address-list]");
  const empty = document.querySelector("[data-deposit-empty]");
  const counter = document.querySelector("[data-deposit-count]");
  if (!list || !empty) return;
  if (counter) counter.textContent = `${depositAddresses.length} 个可用地址`;
  empty.hidden = depositAddresses.length > 0;
  list.replaceChildren(...depositAddresses.map((entry) => {
    const card = document.createElement("div");
    card.className = "deposit-address-card";
    card.dataset.depositAddressId = entry.id;
    if (entry.id === selectedDepositAddressId) card.classList.add("is-selected");

    const radio = document.createElement("button");
    radio.type = "button";
    radio.className = "deposit-address-pick";
    radio.dataset.depositPick = entry.id;
    radio.setAttribute("aria-pressed", String(entry.id === selectedDepositAddressId));

    const qr = document.createElement("img");
    qr.className = "deposit-qr";
    qr.alt = `${entry.label} ${t("w.qrTitle")}`;
    qr.width = 180;
    qr.height = 180;
    qr.loading = "lazy";
    qr.decoding = "async";
    qr.src = depositQrUrl(entry.address);
    qr.addEventListener("error", () => {
      qr.hidden = true;
      const fallback = document.createElement("div");
      fallback.className = "deposit-qr-fallback";
      fallback.textContent = t("w.qrFallback");
      qr.replaceWith(fallback);
    });

    const body = document.createElement("div");
    body.className = "deposit-address-body";
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const value = document.createElement("code");
    value.textContent = entry.address;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "invitation-chip-copy";
    copy.dataset.depositCopy = entry.address;
    copy.dataset.i18nAria = "w.copyAddress";
    copy.setAttribute("aria-label", t("w.copyAddress"));
    copy.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11.5" height="11.5" rx="2.5" /><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" /></svg>`;
    if (entry.note) {
      const note = document.createElement("small");
      note.textContent = entry.note;
      body.append(label, value, note, copy);
    } else {
      body.append(label, value, copy);
    }
    card.append(qr, body);
    radio.append(card);
    return radio;
  }));
}

document.addEventListener("click", (event) => {
  const pick = event.target.closest("[data-deposit-pick]");
  if (pick) {
    selectedDepositAddressId = Number(pick.dataset.depositPick);
    document.querySelectorAll("[data-deposit-address-id]").forEach((card) => {
      card.classList.remove("is-selected");
    });
    renderDepositAddresses();
    return;
  }
  const copy = event.target.closest("[data-deposit-copy]");
  if (copy) {
    event.stopPropagation();
    const address = copy.dataset.depositCopy;
    navigator.clipboard?.writeText(address).then(() => {
      showToast(t("w.addressCopied", { address }));
    }).catch(() => {
      showToast(address);
    });
  }
});

function renderWallet() {
  const pendingWithdrawalUnits = wallet.requests
    .filter((request) => request.kind === "withdraw" && request.status === "pending")
    .reduce((sum, request) => sum + request.amountUnits, 0);
  const totalBalance = wallet.balance + getReservedBalance() + pendingWithdrawalUnits;
  const formatted = formatGram(totalBalance);
  const available = `${formatGram(wallet.balance)} GRAM`;
  document.querySelectorAll("[data-wallet-balance]").forEach((element) => {
    element.dataset.balance = formatted;
    element.textContent = formatted;
  });
  document.querySelectorAll("[data-wallet-total]").forEach((element) => {
    element.textContent = `${formatted} GRAM`;
  });
  document.querySelectorAll("[data-wallet-available]").forEach((element) => {
    element.textContent = available;
  });
  const eyeButton = document.querySelector(".eye-button");
  if (eyeButton?.getAttribute("aria-pressed") === "true") {
    document.querySelectorAll(".balance-value").forEach((element) => {
      element.textContent = "••••";
    });
    document.querySelectorAll(".market-price").forEach((element) => {
      element.textContent = "••••••";
    });
  }
  amountInput.max = String(wallet.balance / 100);
  document.querySelector("[data-fill='max']").disabled = wallet.balance <= 0;
  renderDepositAddresses();
  renderWalletHistory();
  renderMyCollection();
  syncSelectedPoolUI();
  renderPoolStates();
  updateAmountFeedback();
}

function renderWalletHistory() {
  const historyList = document.querySelector("[data-wallet-history]");
  if (!historyList) return;
  if (wallet.history.length === 0 && wallet.requests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wallet-history-empty";
    empty.textContent = t("wh.empty");
    historyList.replaceChildren(empty);
    return;
  }

  const entries = wallet.history.slice(0, 6).map((entry) => {
    const row = document.createElement("div");
    row.className = "wallet-history-item";
    const icon = document.createElement("span");
    icon.className = `wallet-history-icon ${entry.kind}`;
    icon.textContent = ["deposit", "mint-win", "collectible-reward", "admin-credit", "withdraw-release"].includes(entry.kind) ? "↑" : "↓";
    const details = document.createElement("span");
    details.className = "wallet-history-copy";
    const title = document.createElement("strong");
    const walletLabels = {
      deposit: "wh.deposit",
      withdraw: "wh.withdraw",
      "mint-win": "wh.mintWin",
      "mint-loss": "wh.mintLoss",
      "collectible-reward": "wh.reward",
      "admin-credit": "wh.adminCredit",
      "admin-debit": "wh.adminDebit",
      "withdraw-release": "wh.withdrawRelease",
    };
    title.textContent = walletLabels[entry.kind] ? t(walletLabels[entry.kind]) : t("wh.default");
    const time = document.createElement("small");
    time.textContent = `${new Intl.DateTimeFormat(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt))} · ${t("wh.serverRecord")}`;
    details.append(title, time);
    const amount = document.createElement("strong");
    amount.className = `wallet-history-amount ${entry.kind}`;
    const isCredit = ["deposit", "mint-win", "collectible-reward", "admin-credit", "withdraw-release"].includes(entry.kind);
    amount.textContent = `${isCredit ? "+" : "−"}${formatGram(entry.amount)} G`;
    row.append(icon, details, amount);
    return row;
  });
  const requestEntries = wallet.requests.slice(0, 6).map((request) => {
    const row = document.createElement("div");
    row.className = "wallet-history-item";
    const icon = document.createElement("span");
    icon.className = `wallet-history-icon ${request.kind}`;
    icon.textContent = request.status === "approved" ? "✓" : request.status === "cancelled" ? "×" : "…";
    const details = document.createElement("span");
    details.className = "wallet-history-copy";
    const title = document.createElement("strong");
    title.textContent = `${request.kind === "deposit" ? t("wh.depositRequest") : t("wh.withdrawRequest")} · ${
      request.status === "pending" ? t("wh.pendingReview") : request.status === "approved" ? t("wh.approved") : t("wh.cancelled")
    }`;
    const time = document.createElement("small");
    time.textContent = `${new Intl.DateTimeFormat(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(request.createdAt))} · ${
      request.kind === "withdraw" && request.status === "pending" ? t("wh.frozen") : t("wh.reviewProcess")
    }`;
    details.append(title, time);
    const amount = document.createElement("strong");
    amount.className = "wallet-history-amount";
    amount.textContent = `${request.kind === "deposit" ? "+" : "−"}${formatGram(request.amountUnits)} G`;
    row.append(icon, details, amount);
    return row;
  });
  historyList.replaceChildren(...requestEntries, ...entries);
}

function addWalletHistory(kind, amount) {
  wallet.history.unshift({ kind, amount, createdAt: new Date().toISOString() });
  wallet.history = wallet.history.slice(0, 20);
  saveWallet();
  renderWallet();
}

function setWalletMode(mode) {
  walletMode = mode;
  document.querySelector("[data-wallet-title]").textContent = mode === "deposit" ? t("w.deposit") : t("w.withdraw");
  document.querySelector("[data-wallet-deposit-panel]").hidden = mode !== "deposit";
  document.querySelector("[data-wallet-withdraw-panel]").hidden = mode !== "withdraw";
  document.querySelector("[data-wallet-confirm-panel]").hidden = true;
  document.querySelectorAll("[data-wallet-tab]").forEach((tab) => {
    const active = tab.dataset.walletTab === mode;
    tab.setAttribute("aria-pressed", String(active));
    tab.classList.toggle("is-active", active);
  });
  if (mode === "deposit") document.querySelector("#deposit-amount").focus();
  else document.querySelector("#withdraw-address").focus();
}

function openWallet(mode, opener) {
  walletOpener = opener;
  setWalletMode(mode);
  walletModal.classList.add("is-open");
  walletModal.setAttribute("aria-hidden", "false");
}

function closeWallet() {
  walletModal.classList.remove("is-open");
  walletModal.setAttribute("aria-hidden", "true");
  document.querySelector("[data-wallet-confirm-panel]").hidden = true;
  document.querySelector("[data-wallet-withdraw-panel]").hidden = walletMode !== "withdraw";
  if (walletOpener?.isConnected) walletOpener.focus();
}

function showWalletFeedback(selector, message) {
  document.querySelector(selector).textContent = message;
}

function canEnterPool(level) {
  const rule = poolRules[level];
  return Boolean(rule && rule.enabled !== false && wallet.balance + getReservedBalance() >= Math.round(rule.balance * 100));
}

function getProfitRate(level) {
  return poolRules[level]?.profitPercent ?? 20 + level * 10;
}

function syncSelectedPoolUI() {
  const rule = poolRules[selected.level];
  if (!rule) return;
  document.querySelectorAll(".pool-card[data-level]").forEach((card) => {
    const active = Number(card.dataset.level) === selected.level;
    card.classList.toggle("is-selected", active);
    card.setAttribute("aria-pressed", String(active));
  });
  levelLabel.textContent = `LV.${String(selected.level).padStart(2, "0")} ${poolName(rule)}`;
  document.querySelector("[data-selected-level-index]").textContent =
    `${String(selected.level).padStart(2, "0")} / 08`;
  document.querySelector("[data-minimum-stake]").textContent =
    t("pool.minStakeHint", { amount: rule.minimum.toLocaleString("en-US") });
  document.querySelector("[data-selected-win-chance]").textContent =
    `${((rule.winProbabilityBp || 0) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  amountInput.min = String(rule.minimum);
}

function savePoolRounds() {
  return undefined;
}

function roundSecondsRemaining(level) {
  const round = poolRounds[level];
  return round?.endsAt ? Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000)) : 0;
}

function renderPoolStates() {
  document.querySelectorAll(".pool-card[data-level]").forEach((card) => {
    const level = Number(card.dataset.level);
    const rule = poolRules[level];
    if (!rule) return;

    const round = poolRounds[level];
    const remaining = roundSecondsRemaining(level);
    if (round.endsAt && remaining === 0) {
      settleRound(level);
    }

    const eligible = canEnterPool(level);
    const active = remaining > 0;
    card.disabled = !eligible || active;
    card.classList.toggle("is-locked", !eligible);
    card.classList.toggle("is-round-active", active);
    card.classList.toggle("is-round-complete", round.completed);
    card.classList.toggle("is-selected", level === selected.level);
    card.setAttribute("aria-pressed", String(level === selected.level));
    card.querySelector("[data-pool-status]").textContent =
      active ? t("pool.running") : !eligible ? t("pool.locked") : round.completed
        ? round.won ? t("pool.roundWin") : t("pool.roundLoss")
        : t("pool.unlocked");
    card.querySelector("[data-pool-requirement]").textContent =
      t("pool.requirement", { amount: rule.balance.toLocaleString("en-US") });
    card.querySelector("[data-pool-stake]").textContent = rule.minimum.toLocaleString("en-US");
    card.querySelector("[data-pool-stake-label]").textContent = t("pool.minStake");
    card.querySelector("[data-pool-timer]").textContent =
      formatCountdown(active ? remaining : rule.duration);
    card.querySelector("[data-pool-profit]").textContent = `+${getProfitRate(level)}%`;
  });

  const selectedRule = poolRules[selected.level];
  const selectedRound = poolRounds[selected.level];
  const remaining = roundSecondsRemaining(selected.level);
  const active = remaining > 0;
  const eligible = canEnterPool(selected.level);
  document.querySelector("[data-session-timer]").textContent =
    formatCountdown(active ? remaining : selectedRule.duration);
  document.querySelector("[data-session-state]").textContent =
    active ? t("pool.running") : !eligible ? t("pool.needTier") : selectedRound.completed
      ? selectedRound.won ? t("pool.roundWin") : t("pool.roundLoss")
      : t("pool.sessionState");
  document.querySelector("[data-selected-profit]").textContent = `+${getProfitRate(selected.level)}%`;
  document.querySelector("[data-round-probability]").textContent =
    `${((selectedRound.winProbabilityBp || selectedRule.winProbabilityBp || 0) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

  const startButton = document.querySelector("[data-start-mint]");
  startButton.disabled = !eligible || active;
  startButton.firstChild.textContent = active ? t("pool.running") + " " : t("pool.start") + " ";
}

renderWallet();

function updateAmountFeedback() {
  const rule = poolRules[selected.level];
  const value = Number(amountInput.value);
  let message = "";

  if (!canEnterPool(selected.level)) {
    message = t("dyn.needTierUnlock", { amount: rule.balance.toLocaleString("en-US") });
  } else if (!Number.isFinite(value) || value < rule.minimum) {
    message = t("dyn.minStakeInput", { amount: rule.minimum.toLocaleString("en-US") });
  } else if (Math.round(value * 100) > wallet.balance) {
    message = t("dyn.overBalance");
  }

  amountFeedback.textContent = message;
  amountInput.setCustomValidity(message);
  return !message;
}

function renderRoundActivity(level) {
  const round = poolRounds[level];
  if (!round.startedAt) return;
  const roundId = `${level}-${round.startedAt}`;
  activityList.querySelector(`[data-round-id="${roundId}"]`)?.remove();

  const row = document.createElement("div");
  row.className = "activity-row";
  row.dataset.roundId = roundId;

  const token = document.createElement("div");
  token.className = "activity-token";
  token.textContent = String(level).padStart(2, "0");

  const details = document.createElement("div");
  details.className = "activity-copy";
  const title = document.createElement("strong");
  title.textContent = `${poolName(poolRules[level])} · ${t("pool.methodShort")} ${String(round.method).padStart(2, "0")}`;
  const timestamp = document.createElement("span");
  timestamp.textContent = `${new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(round.startedAt))} · ${t("pool.done")}`;
  details.append(title, timestamp);

  const result = document.createElement("div");
  result.className = "activity-result";
  const amount = document.createElement("strong");
  const resultText = document.createElement("span");
  if (!round.settled) {
    amount.textContent = `${formatGram(round.betAmount)} G`;
    resultText.textContent = t("round.counting");
  } else if (round.won) {
    amount.textContent = `+${formatGram(round.profitAmount)} G`;
    resultText.textContent = t("round.profitLine", { rate: round.profitPercent });
  } else {
    amount.textContent = `−${formatGram(round.betAmount)} G`;
    resultText.textContent = t("round.lossLine");
  }
  result.append(amount, resultText);
  row.append(token, details, result);
  activityList.prepend(row);
}

function renderSavedRoundActivity() {
  Object.keys(poolRounds)
    .map(Number)
    .filter((level) => poolRounds[level].startedAt > 0)
    .sort((first, second) => poolRounds[second].startedAt - poolRounds[first].startedAt)
    .forEach(renderRoundActivity);
}

function openRoundExperience(level) {
  const round = poolRounds[level];
  if (!round?.startedAt) return;
  selected.level = level;
  syncSelectedPoolUI();
  roundModal.classList.add("is-open");
  roundModal.setAttribute("aria-hidden", "false");
  roundModal.dataset.roundLevel = String(level);
  if (round.completed) showRoundResult(level);
  else {
    document.querySelector("[data-round-running]").hidden = false;
    document.querySelector("[data-round-result]").hidden = true;
    renderRoundExperience();
    document.querySelector("[data-round-minimize]").focus();
  }
}

function closeRoundExperience() {
  roundModal.classList.remove("is-open");
  roundModal.setAttribute("aria-hidden", "true");
  document.querySelector("[data-start-mint]").focus();
}

function showRoundResult(level) {
  const round = poolRounds[level];
  const won = round.won === true;
  const resultPanel = document.querySelector("[data-round-result]");
  document.querySelector("[data-round-running]").hidden = true;
  resultPanel.hidden = false;
  document.querySelector("[data-round-result-mark]").textContent = won ? "✦" : "×";
  document.querySelector("[data-round-result-mark]").classList.toggle("is-loss", !won);
  document.querySelector("[data-round-result-heading]").textContent = won ? t("round.resultWin") : t("round.resultLoss");
  document.querySelector("[data-round-result-copy]").textContent = won
    ? t("round.winDesc", { amount: formatGram(round.profitAmount) })
    : t("round.lossDesc", { amount: formatGram(round.betAmount) });
  document.querySelector("[data-round-final-amount]").textContent =
    `${won ? "+" : "−"}${formatGram(won ? round.profitAmount : round.betAmount)} GRAM`;
  document.querySelector("[data-round-final-amount]").classList.toggle("is-loss", !won);
  document.querySelector("[data-round-result-stake]").textContent = `${formatGram(round.betAmount)} GRAM`;
  document.querySelector("[data-round-result-rate]").textContent = `+${round.profitPercent}%`;
  document.querySelector("[data-round-result-balance]").textContent =
    `${formatGram(wallet.balance + getReservedBalance())} GRAM`;
  const proof = round.fairnessSecret
    ? t("round.fairnessProof", {
        commitment: round.fairnessCommitment,
        secret: round.fairnessSecret,
        nonce: round.fairnessNonce,
        draw: round.fairnessDraw,
        threshold: round.winProbabilityBp,
      })
    : t("round.noProof");
  document.querySelector("[data-round-fairness-proof]").textContent = proof;
  document.querySelector("[data-round-probability]").textContent =
    `${((round.winProbabilityBp || 0) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  roundModal.classList.add("is-open");
  roundModal.setAttribute("aria-hidden", "false");
  document.querySelector("[data-round-result-close]").focus();
}

function settleRound(level) {
  const round = poolRounds[level];
  if (!round || round.settled || apiPendingRounds.has(level)) return;
  apiPendingRounds.add(level);
  refreshServerState()
    .then(() => {
      const refreshedRound = poolRounds[level];
      if (refreshedRound.settled && refreshedRound.completed) {
        renderRoundActivity(level);
        showRoundResult(level);
        showToast(refreshedRound.won
          ? t("dyn.roundWonToast", { amount: formatGram(refreshedRound.profitAmount) })
          : t("dyn.roundLostToast", { amount: formatGram(refreshedRound.betAmount) }));
      }
      apiPendingRounds.delete(level);
    })
    .catch((error) => {
      showToast(t("dyn.serverSyncFailed", { message: error.message }));
      setTimeout(() => apiPendingRounds.delete(level), 3000);
    });
}

function renderRoundExperience() {
  if (!roundModal.classList.contains("is-open")) return;
  const activeLevel = Number(roundModal.dataset.roundLevel);
  const round = poolRounds[activeLevel];
  if (!round || round.completed) return;

  const rule = poolRules[activeLevel];
  const remaining = roundSecondsRemaining(activeLevel);
  const progress = Math.min(1, Math.max(0, 1 - remaining / rule.duration));
  document.querySelector("[data-round-pool-name]").textContent =
    `LV.${String(activeLevel).padStart(2, "0")} ${poolName(rule)}`;
  document.querySelector("[data-round-countdown]").textContent = formatCountdown(remaining);
  document.querySelector("[data-round-progress]").style.transform = `scaleX(${progress})`;
  document.querySelector("[data-round-stake]").textContent = `${formatGram(round.betAmount)} GRAM`;
  document.querySelector("[data-round-rate]").textContent = `+${round.profitPercent}%`;

  const showProfit = Math.random() < 0.5;
  const changingAmount = showProfit ? Math.round(round.betAmount * round.profitPercent / 100) : round.betAmount;
  document.querySelector("[data-round-probability]").textContent =
    `${((round.winProbabilityBp || 0) / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const flashCard = document.querySelector("[data-round-flash-card]");
  flashCard.classList.toggle("is-loss", !showProfit);
  document.querySelector("[data-round-flash-label]").textContent =
    showProfit ? t("dyn.settleWin") : t("dyn.settleLoss");
  document.querySelector("[data-round-flash-amount]").textContent =
    `${showProfit ? "+" : "−"}${formatGram(changingAmount)} GRAM`;
}

function setLevel(level) {
  const rule = poolRules[level];
  if (!rule || !canEnterPool(level) || roundSecondsRemaining(level) > 0) return;

  selected.level = level;
  syncSelectedPoolUI();
  amountInput.value = String(Math.max(rule.minimum, Number(amountInput.value) || rule.minimum));
  renderPoolStates();
  updateAmountFeedback();
}

function setMethod(method) {
  selected.method = method;
  document.querySelectorAll(".method-card").forEach((card) => {
    const isSelected = Number(card.dataset.method) === method;
    card.classList.toggle("is-selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  });
}

function openModal() {
  if (!canEnterPool(selected.level) || roundSecondsRemaining(selected.level) > 0) {
    renderPoolStates();
    updateAmountFeedback();
    return;
  }
  if (!updateAmountFeedback()) {
    amountInput.reportValidity();
    return;
  }

  if (Math.round(Number(amountInput.value) * 100) > wallet.balance) {
    amountInput.reportValidity();
    return;
  }

  modal.querySelector("[data-modal-amount]").textContent =
    `${Number(amountInput.value).toLocaleString("en-US")} GRAM`;
  modal.querySelector("[data-modal-method]").textContent = `${t("pool.methodShort")} ${String(selected.method).padStart(2, "0")}`;
  const betAmount = parseGramInput(amountInput.value);
  const rate = getProfitRate(selected.level);
  modal.querySelector("[data-modal-profit]").textContent =
    `+${formatGram(Math.round(betAmount * rate / 100))} GRAM（+${rate}%）`;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  modal.querySelector("[data-modal-confirm]").focus();
}

function closeModal() {
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.querySelector("[data-start-mint]").focus();
}

document.querySelectorAll(".pool-card[data-level]").forEach((card) => {
  card.addEventListener("click", () => setLevel(Number(card.dataset.level)));
});

document.querySelectorAll(".method-card").forEach((card) => {
  card.addEventListener("click", () => setMethod(Number(card.dataset.method)));
});

amountInput.addEventListener("input", updateAmountFeedback);
document.querySelector("[data-fill='max']").addEventListener("click", () => {
  amountInput.value = String(wallet.balance / 100);
  updateAmountFeedback();
});

document.querySelector("[data-start-mint]").addEventListener("click", openModal);
document.querySelectorAll("[data-modal-close]").forEach((button) => button.addEventListener("click", closeModal));
document.querySelector("[data-modal-confirm]").addEventListener("click", async () => {
  if (!canEnterPool(selected.level) || roundSecondsRemaining(selected.level) > 0) {
    closeModal();
    renderPoolStates();
    showToast(t("dyn.stateChanged"));
    return;
  }

  const amount = parseGramInput(amountInput.value);
  if (amount === null || amount > wallet.balance) {
    closeModal();
    updateAmountFeedback();
    showToast(t("dyn.insufficient"));
    return;
  }

  const level = selected.level;
  const button = document.querySelector("[data-modal-confirm]");
  button.disabled = true;
  try {
    await apiRequest("/api/rounds", {
      method: "POST",
      body: { level, method: selected.method, amountUnits: amount },
    });
    await refreshServerState();
    closeModal();
    renderRoundActivity(level);
    openRoundExperience(level);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

function maskBalance(isHidden) {
  document.querySelectorAll(".balance-value").forEach((element) => {
    element.textContent = isHidden ? "••••" : element.dataset.balance || element.textContent;
  });
  document.querySelectorAll(".market-price").forEach((element) => {
    element.textContent = isHidden ? "••••••" : element.dataset.price || element.textContent;
  });
}

document.querySelector(".eye-button")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const hidden = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(hidden));
  maskBalance(hidden);
});

document.querySelectorAll("[data-wallet-open]").forEach((button) => {
  button.addEventListener("click", () => openWallet(button.dataset.walletOpen, button));
});

document.querySelectorAll("[data-wallet-tab]").forEach((button) => {
  button.addEventListener("click", () => setWalletMode(button.dataset.walletTab));
});

document.querySelectorAll("[data-wallet-close]").forEach((button) => {
  button.addEventListener("click", closeWallet);
});

walletModal.addEventListener("click", (event) => {
  if (event.target === walletModal) closeWallet();
});

document.querySelector("[data-deposit-submit]").addEventListener("click", async () => {
  const amount = parseGramInput(document.querySelector("#deposit-amount").value);
  if (amount === null) {
    showWalletFeedback("[data-deposit-feedback]", t("dyn.depositAmountPositive"));
    return;
  }
  const chosen = depositAddresses.find((entry) => entry.id === selectedDepositAddressId);
  if (!chosen) {
    showWalletFeedback("[data-deposit-feedback]", t("dyn.depositNeedAddress"));
    return;
  }
  try {
    const result = await apiRequest("/api/wallet/deposit", {
      method: "POST",
      body: { amountUnits: amount, address: `${chosen.label}｜${chosen.address}` },
    });
    applyServerState(result.state);
    document.querySelector("#deposit-amount").value = "";
    showWalletFeedback("[data-deposit-feedback]", "");
    closeWallet();
    showToast(t("dyn.depositSubmitted", { amount: formatGram(amount) }));
  } catch (error) {
    showWalletFeedback("[data-deposit-feedback]", error.message);
  }
});

document.querySelector("[data-withdraw-max]").addEventListener("click", () => {
  document.querySelector("#withdraw-amount").value = String(wallet.balance / 100);
  showWalletFeedback("[data-withdraw-feedback]", "");
});

document.querySelector("[data-withdraw-submit]").addEventListener("click", () => {
  const address = document.querySelector("#withdraw-address").value.trim();
  const amount = parseGramInput(document.querySelector("#withdraw-amount").value);
  if (address.length < 8) {
    showWalletFeedback("[data-withdraw-feedback]", t("dyn.addressShort"));
    document.querySelector("#withdraw-address").focus();
    return;
  }
  if (amount === null) {
    showWalletFeedback("[data-withdraw-feedback]", t("dyn.withdrawAmountPositive"));
    document.querySelector("#withdraw-amount").focus();
    return;
  }
  if (amount > wallet.balance) {
    showWalletFeedback("[data-withdraw-feedback]", t("dyn.withdrawOver"));
    return;
  }

  document.querySelector("[data-confirm-address]").textContent =
    `${address.slice(0, 8)}${address.length > 16 ? `…${address.slice(-6)}` : ""}`;
  document.querySelector("[data-confirm-amount]").textContent = `${formatGram(amount)} GRAM`;
  document.querySelector("[data-wallet-withdraw-panel]").hidden = true;
  document.querySelector("[data-wallet-confirm-panel]").hidden = false;
  document.querySelector("[data-withdraw-confirm]").focus();
});

document.querySelector("[data-wallet-back]").addEventListener("click", () => {
  document.querySelector("[data-wallet-confirm-panel]").hidden = true;
  document.querySelector("[data-wallet-withdraw-panel]").hidden = false;
  document.querySelector("[data-withdraw-submit]").focus();
});

document.querySelector("[data-withdraw-confirm]").addEventListener("click", async () => {
  const amount = parseGramInput(document.querySelector("#withdraw-amount").value);
  if (amount === null || amount > wallet.balance) {
    showWalletFeedback("[data-withdraw-feedback]", t("dyn.balanceChanged"));
    setWalletMode("withdraw");
    return;
  }
  try {
    const address = document.querySelector("#withdraw-address").value.trim();
    const result = await apiRequest("/api/wallet/withdraw", { method: "POST", body: { amountUnits: amount, address } });
    applyServerState(result.state);
    document.querySelector("#withdraw-address").value = "";
    document.querySelector("#withdraw-amount").value = "";
    closeWallet();
    showToast(t("dyn.withdrawSubmitted", { amount: formatGram(amount) }));
  } catch (error) {
    showWalletFeedback("[data-withdraw-feedback]", error.message);
  }
});

document.querySelectorAll("[data-toast]").forEach((button) => {
  button.addEventListener("click", () => showToast(t(button.dataset.toast)));
});

document.querySelector("[data-notifications-button]").addEventListener("click", () => {
  showToast(t("dyn.noNotifications"));
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  if (event.key === "Escape" && walletModal.classList.contains("is-open")) closeWallet();
  if (event.key === "Escape" && roundModal.classList.contains("is-open")) closeRoundExperience();
  if (event.key === "Escape" && giftDetail.classList.contains("is-open")) closeGiftDetail();
  if (event.key === "Escape" && languageModal.classList.contains("is-open")) closeLanguageModal();
});

document.querySelectorAll("[data-round-minimize]").forEach((button) => {
  button.addEventListener("click", closeRoundExperience);
});
document.querySelector("[data-round-result-close]").addEventListener("click", closeRoundExperience);

const authScreen = document.querySelector("[data-auth-screen]");
const platform = document.querySelector("[data-platform]");
const authUserLabel = document.querySelector("[data-auth-user]");

function showAuthFeedback(formName, message = "") {
  document.querySelector(`[data-auth-feedback="${formName}"]`).textContent = message;
}

async function enterPlatform(user) {
  const state = await refreshServerState();
  authenticatedUsername = user.username;
  authUserLabel.textContent = user.displayName || user.username;
  authScreen.hidden = true;
  platform.hidden = false;
  const activeLevel = Object.entries(poolRounds)
    .filter(([, round]) => round.endsAt > Date.now() && !round.settled)
    .map(([level]) => Number(level))
    .sort((first, second) => poolRounds[second].endsAt - poolRounds[first].endsAt)[0];
  if (activeLevel) openRoundExperience(activeLevel);
  return state;
}

function setAuthTab(tabName) {
  document.querySelectorAll("[data-auth-tab]").forEach((tab) => {
    const isActive = tab.dataset.authTab === tabName;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  document.querySelectorAll("[data-auth-form]").forEach((form) => {
    form.hidden = form.dataset.authForm !== tabName;
  });
  document.querySelector("#auth-heading").textContent = tabName === "login" ? t("auth.headingLogin") : t("auth.createHeading");
  showAuthFeedback("login");
  showAuthFeedback("register");
}

document.querySelectorAll("[data-auth-tab]").forEach((tab) => {
  tab.addEventListener("click", () => setAuthTab(tab.dataset.authTab));
});

document.querySelector('[data-auth-form="register"]').addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const invitationCode = form.elements.invitationCode ? form.elements.invitationCode.value.trim().toUpperCase() : "";
  const password = form.elements.password.value;
  const passwordConfirm = form.elements.passwordConfirm.value;
  const submitButton = form.querySelector('[type="submit"]');

  showAuthFeedback("register");
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) {
    showAuthFeedback("register", t("auth.errUsernameFormat"));
    return;
  }
  if (password.length < 8) {
    showAuthFeedback("register", t("auth.errPasswordShort"));
    return;
  }
  if (password !== passwordConfirm) {
    showAuthFeedback("register", t("auth.errPasswordMismatch"));
    return;
  }
  if (invitationCode && !/^[A-Z0-9]{5}$/.test(invitationCode)) {
    showAuthFeedback("register", t("auth.errInvitationFormat"));
    return;
  }
  if (!invitationCode) {
    showAuthFeedback("register", t("auth.errInvitationRequired"));
    return;
  }

  submitButton.disabled = true;
  try {
    const result = await apiRequest("/api/register", { method: "POST", body: { username, password, invitationCode } });
    form.reset();
    await enterPlatform(result.user);
  } catch (error) {
    showAuthFeedback("register", error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('[data-auth-form="login"]').addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  const submitButton = form.querySelector('[type="submit"]');

  showAuthFeedback("login");
  if (!username || !password) {
    showAuthFeedback("login", t("auth.errRequired"));
    return;
  }

  submitButton.disabled = true;
  try {
    const result = await apiRequest("/api/login", { method: "POST", body: { username, password } });
    form.reset();
    await enterPlatform(result.user);
  } catch (error) {
    showAuthFeedback("login", error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("[data-auth-logout]").addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST", body: {} });
  } catch (error) {
    showToast(t("dyn.logoutFailed", { message: error.message }));
    return;
  }
  authenticatedUsername = "";
  csrfToken = "";
  closeRoundExperience();
  closeWallet();
  closeModal();
  closeGiftDetail();
  platform.hidden = true;
  authScreen.hidden = false;
  setAuthTab("login");
  document.querySelector("#login-username").focus();
});

apiRequest("/api/session")
  .then((session) => enterPlatform(session.user))
  .catch((error) => {
    if (error.message !== "请先登录。") {
      showAuthFeedback("login", t("auth.errBackend", { message: error.message }));
    }
  });

setInterval(() => {
  renderPoolStates();
  renderRoundExperience();
  if (authenticatedUsername && Date.now() - lastStateSyncAt > 10_000) {
    lastStateSyncAt = Date.now();
    refreshServerState().catch((error) => showToast(t("dyn.syncFailed", { message: error.message })));
  }
}, 250);
