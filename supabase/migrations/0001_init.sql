-- =====================================================================
-- GRAM 数字典藏平台 · Supabase 数据库基线迁移
--
-- 设计原则：
--   1. 所有表结构对齐原 Ruby 版 SQLite schema，业务字段一一对应
--   2. 全部表启用 RLS 但不授予任何策略 —— 浏览器端（anon / authenticated）
--      无法直接读写任何表，唯一入口是使用 service_role 的 Edge Functions
--   3. 金额、时间仍以「整数单位 / ISO 文本」存储，与既有前端逻辑保持一致
-- =====================================================================

create table if not exists users (
  id              bigserial primary key,
  username        text not null unique,
  display_name    text not null,
  password_salt   text not null,
  password_hash   text not null,
  role            text not null default 'user'
                    check (role in ('user', 'admin', 'agent')),
  status          text not null default 'active'
                    check (status in ('active', 'suspended')),
  balance_units   integer not null default 0 check (balance_units >= 0),
  invitation_code text unique,
  invited_by      bigint references users(id),
  created_at      text not null
);

create table if not exists sessions (
  token_digest text primary key,
  csrf_token   text not null,
  user_id      bigint not null references users(id) on delete cascade,
  expires_at   bigint not null
);

create table if not exists pool_configs (
  level              integer primary key check (level between 1 and 8),
  name               text not null,
  minimum_units      integer not null check (minimum_units > 0),
  entry_units        integer not null check (entry_units > 0),
  duration_seconds   integer not null check (duration_seconds > 0),
  profit_percent     integer not null check (profit_percent > 0),
  win_probability_bp integer not null check (win_probability_bp between 0 and 10000),
  enabled            integer not null default 1 check (enabled in (0, 1))
);

create table if not exists gifts (
  slug      text primary key,
  name      text not null,
  english   text not null,
  category  text not null,
  image_url text not null default '',
  active    integer not null default 1 check (active in (0, 1))
);

create table if not exists rounds (
  id                   text primary key,
  user_id              bigint not null references users(id),
  level                integer not null references pool_configs(level),
  stake_units          integer not null check (stake_units > 0),
  profit_units         integer not null check (profit_units >= 0),
  method               integer not null check (method in (1, 2)),
  win_probability_bp   integer not null,
  profit_percent       integer not null,
  result               integer not null check (result in (0, 1)),
  started_at           bigint not null,
  ends_at              bigint not null,
  settled_at           bigint,
  fairness_secret      text not null,
  fairness_commitment  text not null,
  fairness_nonce       integer not null,
  fairness_draw        integer not null check (fairness_draw between 0 and 9999),
  risk_flag            integer not null default 0 check (risk_flag in (0, 1)),
  risk_note            text,
  forced_outcome       text
);

create index if not exists rounds_user_idx on rounds(user_id, started_at desc);

create table if not exists wallet_events (
  id           bigserial primary key,
  user_id      bigint not null references users(id),
  kind         text not null check (kind in (
                 'deposit', 'withdraw', 'mint-win', 'mint-loss',
                 'admin-credit', 'admin-debit', 'withdraw-release',
                 'collectible-reward')),
  amount_units integer not null,
  created_at   text not null
);

create index if not exists wallet_events_user_idx on wallet_events(user_id, id desc);

create table if not exists wallet_requests (
  id              text primary key,
  user_id         bigint not null references users(id),
  kind            text not null check (kind in ('deposit', 'withdraw')),
  amount_units    integer not null check (amount_units > 0),
  address         text,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'cancelled')),
  created_at      text not null,
  resolved_at     text,
  resolved_by     bigint references users(id),
  resolution_note text
);

create table if not exists holdings (
  id           text primary key,
  user_id      bigint not null references users(id),
  slug         text not null references gifts(slug) on delete cascade,
  status       text not null default 'owned'
                 check (status in ('owned', 'rental', 'interest')),
  started_at   bigint not null,
  earned_units integer not null default 0 check (earned_units >= 0)
);

create index if not exists holdings_user_idx on holdings(user_id, id);

create table if not exists admin_audit (
  id          bigserial primary key,
  admin_id    bigint not null references users(id),
  action      text not null,
  detail_json text not null,
  created_at  text not null
);

create index if not exists admin_audit_admin_idx on admin_audit(admin_id, id desc);

create table if not exists deposit_addresses (
  id         bigserial primary key,
  label      text not null,
  address    text not null,
  note       text not null default '',
  active     integer not null default 1 check (active in (0, 1)),
  sort_order integer not null default 0,
  created_at text not null
);

create index if not exists deposit_addresses_active_idx
  on deposit_addresses(active, sort_order);

create index if not exists users_invitation_code_idx on users(invitation_code);

-- ---------------------------------------------------------------------
-- 行级安全：全部启用，且不创建任何策略。
-- 这样 anon / authenticated 角色对任何表都零权限；
-- Edge Functions 以 service_role 连接，天然绕过 RLS，成为唯一数据入口。
-- ---------------------------------------------------------------------
alter table users             enable row level security;
alter table sessions          enable row level security;
alter table pool_configs      enable row level security;
alter table gifts             enable row level security;
alter table rounds            enable row level security;
alter table wallet_events     enable row level security;
alter table wallet_requests   enable row level security;
alter table holdings          enable row level security;
alter table admin_audit       enable row level security;
alter table deposit_addresses enable row level security;

-- ---------------------------------------------------------------------
-- 铸造池与礼物目录的默认数据（与原 server.rb 的 POOL_DEFAULTS / GIFT_DEFAULTS 一致）
-- 表里的单位为「分」，1 GRAM = 100 单位
-- ---------------------------------------------------------------------
insert into pool_configs
  (level, name, minimum_units, entry_units, duration_seconds, profit_percent, win_probability_bp)
values
  (1, '初级池', 1000, 10000, 60, 30, 5000),
    (2, '进阶池', 5000, 60000, 120, 40, 5000),
    (3, '精英池', 30000, 200000, 180, 50, 5000),
    (4, '大师池', 80000, 700000, 240, 60, 5000),
    (5, '星环池', 200000, 2000000, 300, 70, 5000),
    (6, '深空池', 500000, 5000000, 360, 80, 5000),
    (7, '奇点池', 1000000, 10000000, 420, 90, 5000),
    (8, '创世池', 2000000, 20000000, 480, 100, 5000)
on conflict (level) do nothing;

insert into gifts (slug, name, english, category) values
  ('algorithmcup', '算法杯', 'Algorithm Cups', 'other'),
    ('artisanbrick', '匠心砖', 'Artisan Bricks', 'other'),
    ('astralshard', '星界碎片', 'Astral Shards', 'other'),
    ('bdaycandle', '生日蜡烛', 'B-Day Candles', 'celebration'),
    ('berrybox', '莓果礼盒', 'Berry Boxes', 'other'),
    ('bigyear', '吉年', 'Big Years', 'celebration'),
    ('blingbinky', '闪耀奶嘴', 'Bling Binkies', 'other'),
    ('bondedring', '羁绊戒指', 'Bonded Rings', 'accessories'),
    ('bowtie', '领结', 'Bow Ties', 'accessories'),
    ('bunnymuffin', '兔子松饼', 'Bunny Muffins', 'animals'),
    ('candycane', '拐杖糖', 'Candy Canes', 'celebration'),
    ('chillflame', '冷焰', 'Chill Flames', 'other'),
    ('cloverpin', '四叶草胸针', 'Clover Pins', 'accessories'),
    ('cookieheart', '爱心饼干', 'Cookie Hearts', 'celebration'),
    ('crystalball', '水晶球', 'Crystal Balls', 'other'),
    ('cupidcharm', '丘比特吊坠', 'Cupid Charms', 'accessories'),
    ('deskcalendar', '桌面日历', 'Desk Calendars', 'other'),
    ('diamondring', '钻石戒指', 'Diamond Rings', 'accessories'),
    ('durovscap', '杜罗夫帽', 'Durov's Caps', 'accessories'),
    ('durovsglasses', '杜罗夫眼镜', 'Durov's Glasses', 'accessories'),
    ('easteregg', '复活节彩蛋', 'Easter Eggs', 'celebration'),
    ('electricskull', '电光骷髅', 'Electric Skulls', 'other'),
    ('eternalcandle', '永恒蜡烛', 'Eternal Candles', 'celebration'),
    ('eternalrose', '永恒玫瑰', 'Eternal Roses', 'flowers')
on conflict (slug) do nothing;
