-- =====================================================================
-- GRAM 数字典藏平台 · MySQL 8.0 数据库脚本
--
-- 用法（任选其一）：
--   mysql -uroot -p < mysql/schema.sql
--   或在 MySQL Workbench 中打开本文件并执行
--
-- 与原 Ruby 版的字段、单位（1 GRAM = 100）、业务语义完全一致。
-- 原子性依赖「显式事务 + SELECT ... FOR UPDATE」，由 db.rb 适配层实现，
-- 因此这里只需要建表、索引与种子数据，无需存储过程。
-- =====================================================================

-- 建议使用独立数据库与账户，避免直接用 root 跑业务
CREATE DATABASE IF NOT EXISTS gram_platform
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE gram_platform;

-- ---------------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(24)  NOT NULL UNIQUE,
  display_name    VARCHAR(40)  NOT NULL,
  password_salt   VARCHAR(64)  NOT NULL,
  password_hash   VARCHAR(64)  NOT NULL,
  role            VARCHAR(8)   NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'admin', 'agent')),
  status          VARCHAR(10)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
  balance_units   INT          NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
  invitation_code VARCHAR(5)   UNIQUE,
  invited_by      INT          NULL,
  created_at      VARCHAR(32)  NOT NULL,
  CONSTRAINT fk_users_invited_by FOREIGN KEY (invited_by) REFERENCES users(id),
  INDEX idx_users_role (role),
  INDEX idx_users_invitation (invitation_code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 会话（只存令牌哈希）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_digest VARCHAR(64) PRIMARY KEY,
  csrf_token   VARCHAR(64) NOT NULL,
  user_id      INT         NOT NULL,
  expires_at   BIGINT      NOT NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 铸造池规则（单位：分，1 GRAM = 100）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pool_configs (
  level              INT PRIMARY KEY CHECK (level BETWEEN 1 AND 8),
  name               VARCHAR(40)  NOT NULL,
  minimum_units      INT NOT NULL CHECK (minimum_units > 0),
  entry_units        INT NOT NULL CHECK (entry_units > 0),
  duration_seconds   INT NOT NULL CHECK (duration_seconds > 0),
  profit_percent     INT NOT NULL CHECK (profit_percent > 0),
  win_probability_bp INT NOT NULL CHECK (win_probability_bp BETWEEN 0 AND 10000),
  enabled            INT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 礼物目录
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gifts (
  slug      VARCHAR(80) PRIMARY KEY,
  name      VARCHAR(80) NOT NULL,
  english   VARCHAR(80) NOT NULL,
  category  VARCHAR(80) NOT NULL,
  image_url VARCHAR(255) NOT NULL DEFAULT '',
  active    INT NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 铸造轮次（含公开随机承诺）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rounds (
  id                  VARCHAR(36) PRIMARY KEY,
  user_id             INT  NOT NULL,
  level               INT  NOT NULL,
  stake_units         INT  NOT NULL CHECK (stake_units > 0),
  profit_units        INT  NOT NULL CHECK (profit_units >= 0),
  method              INT  NOT NULL CHECK (method IN (1, 2)),
  win_probability_bp  INT  NOT NULL,
  profit_percent      INT  NOT NULL,
  result              INT  NOT NULL CHECK (result IN (0, 1)),
  started_at          BIGINT NOT NULL,
  ends_at             BIGINT NOT NULL,
  settled_at          BIGINT NULL,
  fairness_secret     VARCHAR(64) NOT NULL,
  fairness_commitment VARCHAR(64) NOT NULL,
  fairness_nonce      INT  NOT NULL,
  fairness_draw       INT  NOT NULL CHECK (fairness_draw BETWEEN 0 AND 9999),
  risk_flag           INT  NOT NULL DEFAULT 0 CHECK (risk_flag IN (0, 1)),
  risk_note           VARCHAR(255) NULL,
  forced_outcome      VARCHAR(8)  NULL,
  CONSTRAINT fk_rounds_user  FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_rounds_level FOREIGN KEY (level) REFERENCES pool_configs(level),
  INDEX idx_rounds_user (user_id, started_at DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 资金流水
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_events (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  kind         VARCHAR(24) NOT NULL
               CHECK (kind IN ('deposit', 'withdraw', 'mint-win', 'mint-loss',
                               'admin-credit', 'admin-debit', 'withdraw-release',
                               'collectible-reward')),
  amount_units INT NOT NULL,
  created_at   VARCHAR(32) NOT NULL,
  CONSTRAINT fk_wallet_events_user FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_wallet_events_user (user_id, id DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 充值 / 提现申请
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_requests (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         INT NOT NULL,
  kind            VARCHAR(8)  NOT NULL CHECK (kind IN ('deposit', 'withdraw')),
  amount_units    INT NOT NULL CHECK (amount_units > 0),
  address         VARCHAR(200) NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'cancelled')),
  created_at      VARCHAR(32) NOT NULL,
  resolved_at     VARCHAR(32) NULL,
  resolved_by     INT NULL,
  resolution_note VARCHAR(200) NULL,
  CONSTRAINT fk_wallet_requests_user     FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_wallet_requests_resolver FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 用户典藏
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings (
  id           VARCHAR(36) PRIMARY KEY,
  user_id      INT NOT NULL,
  slug         VARCHAR(80) NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'owned'
               CHECK (status IN ('owned', 'rental', 'interest')),
  started_at   BIGINT NOT NULL,
  earned_units INT NOT NULL DEFAULT 0 CHECK (earned_units >= 0),
  CONSTRAINT fk_holdings_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_holdings_gift FOREIGN KEY (slug) REFERENCES gifts(slug) ON DELETE CASCADE,
  INDEX idx_holdings_user (user_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 管理审计
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  admin_id    INT NOT NULL,
  action      VARCHAR(48) NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  CONSTRAINT fk_admin_audit_admin FOREIGN KEY (admin_id) REFERENCES users(id),
  INDEX idx_admin_audit_admin (admin_id, id DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 充值地址
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_addresses (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  label      VARCHAR(40) NOT NULL,
  address    VARCHAR(160) NOT NULL,
  note       VARCHAR(200) NOT NULL DEFAULT '',
  active     INT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_deposit_addresses_active (active, sort_order)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- =====================================================================
-- 种子数据：8 个铸造池（数值与原 server.rb 的 POOL_DEFAULTS 一致）
-- =====================================================================
INSERT INTO pool_configs
  (level, name, minimum_units, entry_units, duration_seconds, profit_percent, win_probability_bp)
VALUES
  (1, '初级池',  1000,   10000,  60, 30, 5000),
  (2, '进阶池',  5000,   60000, 120, 40, 5000),
  (3, '精英池', 30000,  200000, 180, 50, 5000),
  (4, '大师池', 80000,  700000, 240, 60, 5000),
  (5, '星环池',200000, 2000000, 300, 70, 5000),
  (6, '深空池',500000, 5000000, 360, 80, 5000),
  (7, '奇点池',1000000,10000000,420, 90, 5000),
  (8, '创世池',2000000,20000000,480,100, 5000)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- 礼物种子数据由 setup.rb 从 server.rb 的 GIFT_DEFAULTS 自动生成，避免手抄错
