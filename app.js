const poolRules = {
  1: { name: "初级池", minimum: 10, balance: 100, duration: 60 },
  2: { name: "进阶池", minimum: 50, balance: 600, duration: 120 },
  3: { name: "精英池", minimum: 300, balance: 2000, duration: 180 },
  4: { name: "大师池", minimum: 800, balance: 7000, duration: 240 },
  5: { name: "星环池", minimum: 2000, balance: 20000, duration: 300 },
  6: { name: "深空池", minimum: 5000, balance: 50000, duration: 360 },
  7: { name: "奇点池", minimum: 10000, balance: 100000, duration: 420 },
  8: { name: "创世池", minimum: 20000, balance: 200000, duration: 480 },
};

const amountInput = document.querySelector("#mint-amount");
const amountFeedback = document.querySelector("[data-amount-feedback]");
const levelLabel = document.querySelector("[data-selected-level]");
const modal = document.querySelector("[data-modal]");
const toast = document.querySelector("[data-toast-box]");
const activityList = document.querySelector("[data-activity-list]");
const selected = { level: 1, method: 1 };
const storedWalletBalance = localStorage.getItem("gram-demo-balance");
const storedPoolRounds = JSON.parse(localStorage.getItem("gram-demo-pool-rounds") || "{}");
const wallet = {
  balance: storedWalletBalance === null ? 128000 : Number(storedWalletBalance),
  history: JSON.parse(localStorage.getItem("gram-demo-wallet-history") || "[]"),
};
const walletModal = document.querySelector("[data-wallet-modal]");
const roundModal = document.querySelector("[data-round-modal]");
const poolRounds = Object.fromEntries(
  Array.from({ length: 8 }, (_, index) => {
    const level = index + 1;
    const savedRound = storedPoolRounds[level] || {};
    const endsAt = Number(savedRound.endsAt) || 0;
    const hasBet = Number.isSafeInteger(savedRound.betAmount) && savedRound.betAmount > 0;
    const pendingSettlement = endsAt > 0 && !savedRound.settled && hasBet;
    return [level, {
      endsAt: pendingSettlement ? endsAt : 0,
      completed: savedRound.settled === true || (endsAt > 0 && !hasBet),
      betAmount: hasBet ? savedRound.betAmount : 0,
      profitAmount: Number.isSafeInteger(savedRound.profitAmount) && savedRound.profitAmount >= 0 ? savedRound.profitAmount : 0,
      won: typeof savedRound.won === "boolean" ? savedRound.won : null,
      method: Number(savedRound.method) === 2 ? 2 : 1,
      startedAt: Number(savedRound.startedAt) || 0,
      settled: savedRound.settled === true || !hasBet,
    }];
  }),
);
const activePoolLevel = Object.entries(poolRounds)
  .filter(([, round]) => round.endsAt > Date.now())
  .sort(([, first], [, second]) => second.endsAt - first.endsAt)[0]?.[0];
if (activePoolLevel && poolRules[activePoolLevel]) selected.level = Number(activePoolLevel);
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
const storedHoldings = JSON.parse(localStorage.getItem("gram-demo-collection") || "[]");
const holdings = Array.isArray(storedHoldings)
  ? storedHoldings.filter((item) =>
    item && typeof item.id === "string" &&
    gifts.some((gift) => gift.slug === item.slug) &&
    ["owned", "rental", "interest"].includes(item.status) &&
    Number.isSafeInteger(item.earnedUnits) && item.earnedUnits >= 0 &&
    Number.isFinite(item.startedAt) && item.startedAt >= 0)
  : [];
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
  preview.setAttribute("aria-label", `查看 ${gift.english} 礼物详情`);

  const image = document.createElement("img");
  image.src = `https://fragment.com/file/gifts/${gift.slug}/thumb.webp`;
  image.alt = `${gift.english} Telegram 礼物目录图片`;
  image.loading = index < 4 ? "eager" : "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    preview.classList.add("image-unavailable");
    image.alt = `${gift.english} 图片暂时无法加载`;
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
  favorite.setAttribute("aria-label", favorites.has(gift.slug) ? `取消收藏 ${gift.english}` : `收藏 ${gift.english}`);
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
    `显示 ${displayedGifts.length} / ${matchingGifts.length} 件礼物`;
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
  showToast(isFavorite ? "已取消收藏" : "已加入收藏");
}

function updateGiftDetailFavorite() {
  if (!activeGift) return;
  const isFavorite = readFavoriteSlugs().has(activeGift.slug);
  const button = document.querySelector("[data-detail-favorite]");
  button.textContent = isFavorite ? "♥ 已收藏" : "♡ 收藏礼物";
  button.setAttribute("aria-pressed", String(isFavorite));
}

function updateGiftDetailAddButton() {
  if (!activeGift) return;
  const count = holdings.filter((item) => item.slug === activeGift.slug).length;
  document.querySelector("[data-detail-add]").textContent =
    count > 0 ? `＋ 再添加一件 · 已有 ${count} 件` : "＋ 模拟加入我的典藏";
}

function openGiftDetail(slug) {
  activeGift = gifts.find((gift) => gift.slug === slug) || null;
  if (!activeGift) return;

  const image = giftDetail.querySelector("[data-detail-image]");
  image.src = `https://fragment.com/file/gifts/${activeGift.slug}/thumb.webp`;
  image.alt = `${activeGift.english} Telegram 礼物`;
  giftDetail.querySelector("[data-detail-title]").textContent = `${activeGift.name} · ${activeGift.english}`;
  giftDetail.querySelector("[data-detail-description]").textContent =
    "Telegram 礼物目录中的系列预览。礼物实物、稀有款式、价格和供应量请在来源页面查看。";
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
  localStorage.setItem("gram-demo-collection", JSON.stringify(holdings));
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
  image.alt = `${gift.english} Telegram 礼物演示图`;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    art.classList.add("image-unavailable");
    image.alt = `${gift.english} 图片暂时无法加载`;
  }, { once: true });
  const badge = document.createElement("small");
  badge.className = `holding-status ${item.status}`;
  badge.textContent = item.status === "rental" ? "出租中" : item.status === "interest" ? "生息中" : "我的藏品";
  art.append(image, badge);

  const info = document.createElement("div");
  info.className = "holding-card-info";
  const title = document.createElement("strong");
  title.textContent = gift.name;
  const subtitle = document.createElement("span");
  subtitle.textContent = `${gift.english} · 演示估值 100 G`;
  const earnings = document.createElement("div");
  earnings.className = "holding-earnings";
  const earningsLabel = document.createElement("span");
  earningsLabel.textContent = "累计可领";
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
    addAction("rental", "出租 1%/日", "holding-action-primary");
    addAction("interest", "存入年化 8%", "holding-action-secondary");
  } else {
    addAction("stop", "停止并取回", "holding-action-secondary");
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

  document.querySelector("[data-holding-count]").textContent = `${holdings.length} 件`;
  document.querySelector("[data-rented-count]").textContent = `${rentedCount} 件`;
  document.querySelector("[data-interest-count]").textContent = `${interestCount} 件`;
  document.querySelector("[data-profile-holding-count]").textContent = `${holdings.length} 件`;
  document.querySelector("[data-claimable-amount]").textContent = formatGram(totalEarnings);
  claimButton.disabled = totalEarnings <= 0;
  const emptyState = document.querySelector("[data-holdings-empty]");
  emptyState.hidden = visibleHoldings.length > 0;
  if (holdings.length === 0) {
    emptyState.querySelector("strong").textContent = "这里还没有典藏品";
    emptyState.querySelector("p").textContent = "从下方礼物图鉴选择藏品，加入本地演示典藏。";
  } else if (visibleHoldings.length === 0) {
    emptyState.querySelector("strong").textContent = "这个分类暂时为空";
    emptyState.querySelector("p").textContent = "切换其他筛选，或从礼物图鉴添加演示藏品。";
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
  holdings.unshift({
    id: `${activeGift.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slug: activeGift.slug,
    status: "owned",
    startedAt: 0,
    earnedUnits: 0,
  });
  saveHoldings();
  renderMyCollection();
  showToast("已加入本地演示典藏");
}

function updateHoldingMode(id, mode) {
  const item = holdings.find((holding) => holding.id === id);
  if (!item) return;
  if (mode === "stop") {
    item.earnedUnits = getHoldingEarnings(item);
    item.status = "owned";
    item.startedAt = 0;
    showToast("已停止并取回演示藏品");
  } else {
    item.status = mode;
    item.startedAt = Date.now();
    showToast(mode === "rental" ? "已开始模拟出租" : "已开始模拟存入生息");
  }
  saveHoldings();
  renderMyCollection();
}

function claimCollectionEarnings() {
  const now = Date.now();
  const totalEarnings = holdings.reduce((sum, item) => sum + getHoldingEarnings(item, now), 0);
  if (totalEarnings <= 0) {
    showToast("当前暂无可领取的演示收益");
    return;
  }
  holdings.forEach((item) => {
    item.earnedUnits = 0;
    if (item.status !== "owned") item.startedAt = now;
  });
  saveHoldings();
  wallet.balance += totalEarnings;
  addWalletHistory("collectible-reward", totalEarnings);
  showToast(`已领取 ${formatGram(totalEarnings)} GRAM 演示收益`);
  renderMyCollection();
}

renderGifts();
renderMyCollection();

function setTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-label", isLight ? "切换到黑色模式" : "切换到白色模式");
    button.setAttribute("aria-pressed", String(isLight));
    const label = button.querySelector("[data-theme-name]");
    if (label) label.textContent = isLight ? "白色模式" : "黑色模式";
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
  localStorage.setItem("gram-demo-balance", String(wallet.balance));
  localStorage.setItem("gram-demo-wallet-history", JSON.stringify(wallet.history.slice(0, 20)));
}

function getReservedBalance() {
  return Object.values(poolRounds).reduce((total, round) => {
    return total + (round.endsAt > 0 && !round.settled ? round.betAmount : 0);
  }, 0);
}

function renderWallet() {
  const totalBalance = wallet.balance + getReservedBalance();
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
  }
  amountInput.max = String(wallet.balance / 100);
  document.querySelector("[data-fill='max']").disabled = wallet.balance <= 0;
  renderWalletHistory();
  renderMyCollection();
  syncSelectedPoolUI();
  renderPoolStates();
  updateAmountFeedback();
}

function renderWalletHistory() {
  const historyList = document.querySelector("[data-wallet-history]");
  if (!historyList) return;
  if (wallet.history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "wallet-history-empty";
    empty.textContent = "暂无充值或转出演示记录";
    historyList.replaceChildren(empty);
    return;
  }

  const entries = wallet.history.slice(0, 6).map((entry) => {
    const row = document.createElement("div");
    row.className = "wallet-history-item";
    const icon = document.createElement("span");
    icon.className = `wallet-history-icon ${entry.kind}`;
    icon.textContent = entry.kind === "deposit" || entry.kind === "mint-win" || entry.kind === "collectible-reward" ? "↑" : "↓";
    const details = document.createElement("span");
    details.className = "wallet-history-copy";
    const title = document.createElement("strong");
    title.textContent = {
      deposit: "模拟充值",
      withdraw: "模拟转出",
      "mint-win": "铸造盈利",
      "mint-loss": "铸造亏损",
      "collectible-reward": "典藏演示收益",
    }[entry.kind] || "账户记录";
    const time = document.createElement("small");
    time.textContent = `${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt))} · 本地演示`;
    details.append(title, time);
    const amount = document.createElement("strong");
    amount.className = `wallet-history-amount ${entry.kind}`;
    const isCredit = entry.kind === "deposit" || entry.kind === "mint-win" || entry.kind === "collectible-reward";
    amount.textContent = `${isCredit ? "+" : "−"}${formatGram(entry.amount)} G`;
    row.append(icon, details, amount);
    return row;
  });
  historyList.replaceChildren(...entries);
}

function addWalletHistory(kind, amount) {
  wallet.history.unshift({ kind, amount, createdAt: new Date().toISOString() });
  wallet.history = wallet.history.slice(0, 20);
  saveWallet();
  renderWallet();
}

function setWalletMode(mode) {
  walletMode = mode;
  document.querySelector("[data-wallet-title]").textContent = mode === "deposit" ? "账户充值" : "账户转出";
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
  return Boolean(rule && wallet.balance + getReservedBalance() >= Math.round(rule.balance * 100));
}

function getProfitRate(level) {
  return 20 + level * 10;
}

function syncSelectedPoolUI() {
  const rule = poolRules[selected.level];
  if (!rule) return;
  document.querySelectorAll(".pool-card[data-level]").forEach((card) => {
    const active = Number(card.dataset.level) === selected.level;
    card.classList.toggle("is-selected", active);
    card.setAttribute("aria-pressed", String(active));
  });
  levelLabel.textContent = `LV.${String(selected.level).padStart(2, "0")} ${rule.name}`;
  document.querySelector("[data-selected-level-index]").textContent =
    `${String(selected.level).padStart(2, "0")} / 08`;
  document.querySelector("[data-minimum-stake]").textContent =
    `最低铸造 ${rule.minimum.toLocaleString("en-US")} GRAM`;
  amountInput.min = String(rule.minimum);
}

function savePoolRounds() {
  localStorage.setItem("gram-demo-pool-rounds", JSON.stringify(poolRounds));
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
      active ? "倒计时中" : !eligible ? "资金不足" : round.completed
        ? round.won ? "本轮盈利" : "本轮亏损"
        : "已解锁";
    card.querySelector("[data-pool-requirement]").textContent =
      `账户需 ≥ ${rule.balance.toLocaleString("en-US")} GRAM`;
    card.querySelector("[data-pool-stake]").textContent = rule.minimum.toLocaleString("en-US");
    card.querySelector("[data-pool-stake-label]").textContent = "GRAM 起投";
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
    active ? "倒计时中" : !eligible ? "需达到账户门槛" : selectedRound.completed
      ? selectedRound.won ? "本轮盈利" : "本轮亏损"
      : "下注后开始";
  document.querySelector("[data-selected-profit]").textContent = `+${getProfitRate(selected.level)}%`;

  const startButton = document.querySelector("[data-start-mint]");
  startButton.disabled = !eligible || active;
  startButton.firstChild.textContent = active ? "本池倒计时中 " : "开启演示铸造 ";
}

renderWallet();

function updateAmountFeedback() {
  const rule = poolRules[selected.level];
  const value = Number(amountInput.value);
  let message = "";

  if (!canEnterPool(selected.level)) {
    message = `账户总额需达到 ${rule.balance} GRAM 才能解锁此池`;
  } else if (!Number.isFinite(value) || value < rule.minimum) {
    message = `至少输入 ${rule.minimum.toLocaleString("en-US")} GRAM`;
  } else if (Math.round(value * 100) > wallet.balance) {
    message = "超过演示可用余额";
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
  title.textContent = `${poolRules[level].name} · 方式 ${String(round.method).padStart(2, "0")}`;
  const timestamp = document.createElement("span");
  timestamp.textContent = `${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(round.startedAt))} · 演示记录`;
  details.append(title, timestamp);

  const result = document.createElement("div");
  result.className = "activity-result";
  const amount = document.createElement("strong");
  const resultText = document.createElement("span");
  if (!round.settled) {
    amount.textContent = `${formatGram(round.betAmount)} G`;
    resultText.textContent = "倒计时中 · 已暂扣";
  } else if (round.won) {
    amount.textContent = `+${formatGram(round.profitAmount)} G`;
    resultText.textContent = `盈利 · +${getProfitRate(level)}%`;
  } else {
    amount.textContent = `−${formatGram(round.betAmount)} G`;
    resultText.textContent = "亏损 · 本金全损";
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
  document.querySelector("[data-round-result-heading]").textContent = won ? "恭喜盈利" : "本次亏损";
  document.querySelector("[data-round-result-copy]").textContent = won
    ? `本金已返还，额外盈利 ${formatGram(round.profitAmount)} GRAM。`
    : `本轮未中奖，下注本金 ${formatGram(round.betAmount)} GRAM 已全额损失。`;
  document.querySelector("[data-round-final-amount]").textContent =
    `${won ? "+" : "−"}${formatGram(won ? round.profitAmount : round.betAmount)} GRAM`;
  document.querySelector("[data-round-final-amount]").classList.toggle("is-loss", !won);
  document.querySelector("[data-round-result-stake]").textContent = `${formatGram(round.betAmount)} GRAM`;
  document.querySelector("[data-round-result-rate]").textContent = `+${getProfitRate(level)}%`;
  document.querySelector("[data-round-result-balance]").textContent =
    `${formatGram(wallet.balance + getReservedBalance())} GRAM`;
  roundModal.classList.add("is-open");
  roundModal.setAttribute("aria-hidden", "false");
  document.querySelector("[data-round-result-close]").focus();
}

function settleRound(level) {
  const round = poolRounds[level];
  if (!round || round.settled) return;

  round.endsAt = 0;
  round.completed = true;
  round.settled = true;
  if (round.won) wallet.balance += round.betAmount + round.profitAmount;
  wallet.history.unshift({
    kind: round.won ? "mint-win" : "mint-loss",
    amount: round.won ? round.profitAmount : round.betAmount,
    createdAt: new Date().toISOString(),
  });
  wallet.history = wallet.history.slice(0, 20);
  savePoolRounds();
  saveWallet();

  renderRoundActivity(level);
  renderWallet();
  showRoundResult(level);
  showToast(round.won
    ? `本轮盈利 +${formatGram(round.profitAmount)} GRAM`
    : `本轮亏损 −${formatGram(round.betAmount)} GRAM`);
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
    `LV.${String(activeLevel).padStart(2, "0")} ${rule.name}`;
  document.querySelector("[data-round-countdown]").textContent = formatCountdown(remaining);
  document.querySelector("[data-round-progress]").style.transform = `scaleX(${progress})`;
  document.querySelector("[data-round-stake]").textContent = `${formatGram(round.betAmount)} GRAM`;
  document.querySelector("[data-round-rate]").textContent = `+${getProfitRate(activeLevel)}%`;

  const showProfit = Math.random() < 0.5;
  const changingAmount = showProfit ? round.profitAmount : round.betAmount;
  const flashCard = document.querySelector("[data-round-flash-card]");
  flashCard.classList.toggle("is-loss", !showProfit);
  document.querySelector("[data-round-flash-label]").textContent =
    showProfit ? "模拟盈利波动" : "模拟亏损波动";
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
  modal.querySelector("[data-modal-method]").textContent = `方式 ${String(selected.method).padStart(2, "0")}`;
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
document.querySelector("[data-modal-confirm]").addEventListener("click", () => {
  if (!canEnterPool(selected.level) || roundSecondsRemaining(selected.level) > 0) {
    closeModal();
    renderPoolStates();
    showToast("当前账户余额或本池状态已变化，请重新确认");
    return;
  }

  const amount = parseGramInput(amountInput.value);
  if (amount === null || amount > wallet.balance) {
    closeModal();
    updateAmountFeedback();
    showToast("可用余额不足或下注金额无效，请重新确认");
    return;
  }

  const level = selected.level;
  const rule = poolRules[level];
  const rate = getProfitRate(level);
  const startedAt = Date.now();
  const profitAmount = Math.round(amount * rate / 100);
  wallet.balance -= amount;
  poolRounds[level] = {
    endsAt: startedAt + rule.duration * 1000,
    completed: false,
    settled: false,
    betAmount: amount,
    profitAmount,
    won: Math.random() < 0.5,
    method: selected.method,
    startedAt,
  };
  saveWallet();
  savePoolRounds();
  closeModal();
  renderWallet();
  renderRoundActivity(level);
  openRoundExperience(level);
});

document.querySelector(".eye-button").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const hidden = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(hidden));
  document.querySelectorAll(".balance-value").forEach((element) => {
    element.textContent = hidden ? "••••" : element.dataset.balance;
  });
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

document.querySelector("[data-deposit-submit]").addEventListener("click", () => {
  const amount = parseGramInput(document.querySelector("#deposit-amount").value);
  if (amount === null) {
    showWalletFeedback("[data-deposit-feedback]", "请输入大于 0 的充值金额。");
    return;
  }
  if (!Number.isSafeInteger(wallet.balance + amount)) {
    showWalletFeedback("[data-deposit-feedback]", "金额超出演示账户可记录范围。");
    return;
  }
  wallet.balance += amount;
  addWalletHistory("deposit", amount);
  document.querySelector("#deposit-amount").value = "";
  showWalletFeedback("[data-deposit-feedback]", "");
  closeWallet();
  showToast(`模拟充值成功：+${formatGram(amount)} GRAM`);
});

document.querySelector("[data-withdraw-max]").addEventListener("click", () => {
  document.querySelector("#withdraw-amount").value = String(wallet.balance / 100);
  showWalletFeedback("[data-withdraw-feedback]", "");
});

document.querySelector("[data-withdraw-submit]").addEventListener("click", () => {
  const address = document.querySelector("#withdraw-address").value.trim();
  const amount = parseGramInput(document.querySelector("#withdraw-amount").value);
  if (address.length < 8) {
    showWalletFeedback("[data-withdraw-feedback]", "请填写至少 8 个字符的演示收款地址。");
    document.querySelector("#withdraw-address").focus();
    return;
  }
  if (amount === null) {
    showWalletFeedback("[data-withdraw-feedback]", "请输入大于 0 的转出金额。");
    document.querySelector("#withdraw-amount").focus();
    return;
  }
  if (amount > wallet.balance) {
    showWalletFeedback("[data-withdraw-feedback]", "转出金额超过当前可用演示余额。");
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

document.querySelector("[data-withdraw-confirm]").addEventListener("click", () => {
  const amount = parseGramInput(document.querySelector("#withdraw-amount").value);
  if (amount === null || amount > wallet.balance) {
    showWalletFeedback("[data-withdraw-feedback]", "余额已变化，请检查金额后重试。");
    setWalletMode("withdraw");
    return;
  }
  wallet.balance -= amount;
  addWalletHistory("withdraw", amount);
  document.querySelector("#withdraw-address").value = "";
  document.querySelector("#withdraw-amount").value = "";
  closeWallet();
  showToast(`模拟转出已记录：−${formatGram(amount)} GRAM`);
});

document.querySelectorAll("[data-toast]").forEach((button) => {
  button.addEventListener("click", () => showToast(button.dataset.toast));
});

document.querySelector('[aria-label="打开通知"]').addEventListener("click", () => {
  showToast("暂无新通知");
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  if (event.key === "Escape" && walletModal.classList.contains("is-open")) closeWallet();
  if (event.key === "Escape" && roundModal.classList.contains("is-open")) closeRoundExperience();
  if (event.key === "Escape" && giftDetail.classList.contains("is-open")) closeGiftDetail();
});

document.querySelectorAll("[data-round-minimize]").forEach((button) => {
  button.addEventListener("click", closeRoundExperience);
});
document.querySelector("[data-round-result-close]").addEventListener("click", closeRoundExperience);

renderSavedRoundActivity();
const resumedRoundLevel = Object.entries(poolRounds)
  .filter(([, round]) => round.endsAt > 0 && !round.settled)
  .map(([level]) => Number(level))
  .sort((first, second) => poolRounds[second].endsAt - poolRounds[first].endsAt)[0];
if (resumedRoundLevel) openRoundExperience(resumedRoundLevel);

setInterval(() => {
  renderPoolStates();
  renderRoundExperience();
}, 250);
