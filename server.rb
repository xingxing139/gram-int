require "base64"
require "fileutils"
require "json"
require "openssl"
require "securerandom"
require "time"
require "webrick"
require_relative "db"

ROOT = File.expand_path(__dir__)
DATA_DIR = File.join(ROOT, "data")
DB_PATH = ENV.fetch("GRAM_DATABASE", File.join(DATA_DIR, "gram.sqlite3"))
SESSION_TTL = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 120_000
STARTING_BALANCE = 0
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "123123123123"
ADMIN_PAGE_SIZE = 10
FORCED_OUTCOMES = %w[win lose].freeze
DEMO_COLLECTIBLE_VALUE = 10_000
RENTAL_DAILY_RATE = 0.01
INTEREST_ANNUAL_RATE = 0.08
MUTATION_METHODS = %w[POST PATCH DELETE].freeze

POOL_DEFAULTS = [
  [1, "初级池", 10, 100, 60, 30, 5000],
  [2, "进阶池", 50, 600, 120, 40, 5000],
  [3, "精英池", 300, 2_000, 180, 50, 5000],
  [4, "大师池", 800, 7_000, 240, 60, 5000],
  [5, "星环池", 2_000, 20_000, 300, 70, 5000],
  [6, "深空池", 5_000, 50_000, 360, 80, 5000],
  [7, "奇点池", 10_000, 100_000, 420, 90, 5000],
  [8, "创世池", 20_000, 200_000, 480, 100, 5000],
].freeze

GIFT_DEFAULTS = [
  ["algorithmcup", "算法杯", "Algorithm Cups", "other"],
  ["artisanbrick", "匠心砖", "Artisan Bricks", "other"],
  ["astralshard", "星界碎片", "Astral Shards", "other"],
  ["bdaycandle", "生日蜡烛", "B-Day Candles", "celebration"],
  ["berrybox", "莓果礼盒", "Berry Boxes", "other"],
  ["bigyear", "吉年", "Big Years", "celebration"],
  ["blingbinky", "闪耀奶嘴", "Bling Binkies", "other"],
  ["bondedring", "羁绊戒指", "Bonded Rings", "accessories"],
  ["bowtie", "领结", "Bow Ties", "accessories"],
  ["bunnymuffin", "兔子松饼", "Bunny Muffins", "animals"],
  ["candycane", "拐杖糖", "Candy Canes", "celebration"],
  ["chillflame", "冷焰", "Chill Flames", "other"],
  ["cloverpin", "四叶草胸针", "Clover Pins", "accessories"],
  ["cookieheart", "爱心饼干", "Cookie Hearts", "celebration"],
  ["crystalball", "水晶球", "Crystal Balls", "other"],
  ["cupidcharm", "丘比特吊坠", "Cupid Charms", "accessories"],
  ["deskcalendar", "桌面日历", "Desk Calendars", "other"],
  ["diamondring", "钻石戒指", "Diamond Rings", "accessories"],
  ["durovscap", "杜罗夫帽", "Durov's Caps", "accessories"],
  ["durovsglasses", "杜罗夫眼镜", "Durov's Glasses", "accessories"],
  ["easteregg", "复活节彩蛋", "Easter Eggs", "celebration"],
  ["electricskull", "电光骷髅", "Electric Skulls", "other"],
  ["eternalcandle", "永恒蜡烛", "Eternal Candles", "celebration"],
  ["eternalrose", "永恒玫瑰", "Eternal Roses", "flowers"],
].freeze

class ApiError < StandardError
  attr_reader :status

  def initialize(status, message)
    super(message)
    @status = status
  end
end

class GramService
  attr_reader :database

  def initialize(path = nil)
    @database = path ? GRAMDB::SQLite.new(path) : GRAMDB.build
    @mutex = Mutex.new
    @login_attempts = {}
    initialize_schema
    seed_defaults
    bootstrap_admin
  end

  def synchronize(&block)
    @mutex.synchronize(&block)
  end

  def describe_database
    if database.postgres?
      "PostgreSQL (#{ENV.fetch('DATABASE_URL', '').sub(/\/\/[^@]*@/, '//***@')})"
    else
      "SQLite #{ENV.fetch('GRAM_DATABASE', File.join(DATA_DIR, 'gram.sqlite3'))}"
    end
  end

  def execute(sql, *binds)
    database.execute(sql, *binds)
  end

  def first(sql, *binds)
    database.first(sql, *binds)
  end

  def transaction(&block)
    database.transaction(&block)
  end

  def initialize_schema
    run_schema(database.sqlite? ? sqlite_pragma_prefix : "")
    ensure_column("rounds", "risk_flag", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("rounds", "risk_note", "TEXT")
    ensure_invitation_columns
  end

  def run_schema(prefix)
    database.execute_batch("#{prefix}#{database.sqlite? ? sqlite_schema : postgres_schema}")
  end

  def sqlite_pragma_prefix
    "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\n"
  end

  def sqlite_schema
    <<~SQL
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'agent')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        balance_units INTEGER NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
        invitation_code TEXT UNIQUE,
        invited_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL
      );      CREATE TABLE IF NOT EXISTS sessions (
        token_digest TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pool_configs (
        level INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 8),
        name TEXT NOT NULL,
        minimum_units INTEGER NOT NULL CHECK (minimum_units > 0),
        entry_units INTEGER NOT NULL CHECK (entry_units > 0),
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
        profit_percent INTEGER NOT NULL CHECK (profit_percent BETWEEN 0 AND 500),
        win_probability_bp INTEGER NOT NULL CHECK (win_probability_bp BETWEEN 0 AND 10000),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS gifts (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        english TEXT NOT NULL,
        category TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        level INTEGER NOT NULL REFERENCES pool_configs(level),
        stake_units INTEGER NOT NULL CHECK (stake_units > 0),
        profit_units INTEGER NOT NULL CHECK (profit_units >= 0),
        method INTEGER NOT NULL CHECK (method IN (1, 2)),
        win_probability_bp INTEGER NOT NULL,
        profit_percent INTEGER NOT NULL,
        result INTEGER NOT NULL CHECK (result IN (0, 1)),
        started_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        settled_at INTEGER,
        fairness_secret TEXT NOT NULL,
        fairness_commitment TEXT NOT NULL,
        fairness_nonce INTEGER NOT NULL,
        fairness_draw INTEGER NOT NULL CHECK (fairness_draw BETWEEN 0 AND 9999),
         risk_flag INTEGER NOT NULL DEFAULT 0 CHECK (risk_flag IN (0, 1)),
         risk_note TEXT,
         forced_outcome TEXT
       );
       CREATE INDEX IF NOT EXISTS rounds_user_idx ON rounds(user_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS wallet_events (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL,
        amount_units INTEGER NOT NULL CHECK (amount_units > 0),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wallet_events_user_idx ON wallet_events(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS wallet_requests (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw')),
        amount_units INTEGER NOT NULL CHECK (amount_units > 0),
        address TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by INTEGER REFERENCES users(id),
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS wallet_requests_status_idx ON wallet_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS wallet_requests_user_idx ON wallet_requests(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS holdings (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL REFERENCES gifts(slug),
        status TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned', 'rental', 'interest')),
        earned_units INTEGER NOT NULL DEFAULT 0 CHECK (earned_units >= 0),
        started_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS holdings_user_idx ON holdings(user_id, id);
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposit_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        address TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deposit_addresses_active_idx ON deposit_addresses(active, sort_order);
    SQL
  end

  # PostgreSQL 版 schema：与 SQLite 结构一致，仅自增主键写法不同
  def postgres_schema
    <<~SQL
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'agent')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        balance_units INTEGER NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
        invitation_code TEXT UNIQUE,
        invited_by BIGINT REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_digest TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pool_configs (
        level INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 8),
        name TEXT NOT NULL,
        minimum_units INTEGER NOT NULL CHECK (minimum_units > 0),
        entry_units INTEGER NOT NULL CHECK (entry_units > 0),
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
        profit_percent INTEGER NOT NULL CHECK (profit_percent > 0),
        win_probability_bp INTEGER NOT NULL CHECK (win_probability_bp BETWEEN 0 AND 10000),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS gifts (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        english TEXT NOT NULL,
        category TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        level INTEGER NOT NULL REFERENCES pool_configs(level),
        stake_units INTEGER NOT NULL CHECK (stake_units > 0),
        profit_units INTEGER NOT NULL CHECK (profit_units >= 0),
        method INTEGER NOT NULL CHECK (method IN (1, 2)),
        win_probability_bp INTEGER NOT NULL,
        profit_percent INTEGER NOT NULL,
        result INTEGER NOT NULL CHECK (result IN (0, 1)),
        started_at BIGINT NOT NULL,
        ends_at BIGINT NOT NULL,
        settled_at BIGINT,
        fairness_secret TEXT NOT NULL,
        fairness_commitment TEXT NOT NULL,
        fairness_nonce INTEGER NOT NULL,
        fairness_draw INTEGER NOT NULL CHECK (fairness_draw BETWEEN 0 AND 9999),
        risk_flag INTEGER NOT NULL DEFAULT 0 CHECK (risk_flag IN (0, 1)),
        risk_note TEXT,
        forced_outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS rounds_user_idx ON rounds(user_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS wallet_events (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw', 'mint-win', 'mint-loss', 'admin-credit', 'admin-debit', 'withdraw-release', 'collectible-reward')),
        amount_units INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wallet_events_user_idx ON wallet_events(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS wallet_requests (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw')),
        amount_units INTEGER NOT NULL CHECK (amount_units > 0),
        address TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by BIGINT REFERENCES users(id),
        resolution_note TEXT
      );
      CREATE TABLE IF NOT EXISTS holdings (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL REFERENCES gifts(slug) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned', 'rental', 'interest')),
        started_at BIGINT NOT NULL,
        earned_units INTEGER NOT NULL DEFAULT 0 CHECK (earned_units >= 0)
      );
      CREATE INDEX IF NOT EXISTS holdings_user_idx ON holdings(user_id, id);
      CREATE TABLE IF NOT EXISTS admin_audit (
        id BIGSERIAL PRIMARY KEY,
        admin_id BIGINT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposit_addresses (
        id BIGSERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        address TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deposit_addresses_active_idx ON deposit_addresses(active, sort_order);
    SQL
  end

  def initialize_schema
    run_schema(database.sqlite? ? sqlite_pragma_prefix : "")
    ensure_column("rounds", "risk_flag", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("rounds", "risk_note", "TEXT")
    ensure_invitation_columns
  end

  def ensure_column(table, column, definition)
    columns = database.column_names(table)
    database.execute("ALTER TABLE #{table} ADD COLUMN #{column} #{definition}") unless columns.include?(column)
  end

  def generate_invitation_code
    chars = ("A".."Z").to_a + ("0".."9").to_a
    loop do
      code = 5.times.map { chars.sample }.join
      existing = first("SELECT id FROM users WHERE invitation_code = ?", code)
      return code unless existing
    end
  end

  def ensure_invitation_columns
    ensure_column("users", "invitation_code", "TEXT")
    ensure_column("users", "invited_by", "INTEGER REFERENCES users(id)")
    ensure_column("rounds", "forced_outcome", "TEXT")
    database.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_invitation_code_idx ON users(invitation_code)")
    migrate_users_role_constraint
  end

  def migrate_users_role_constraint
    # PostgreSQL 建表时已包含 agent 角色，无需重建表
    return if database.postgres?
    create_sql = database.table_sql("users")
    return if create_sql.include?("'agent'")

    database.execute("PRAGMA foreign_keys = OFF")
    begin
      database.execute("PRAGMA legacy_alter_table = ON")
      database.execute(<<~SQL)
        CREATE TABLE users_role_migrated (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'agent')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
          balance_units INTEGER NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
          invitation_code TEXT UNIQUE,
          invited_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL
        )
      SQL
      database.execute(
        "INSERT INTO users_role_migrated (id, username, display_name, password_salt, password_hash, role, status, balance_units, invitation_code, invited_by, created_at) " \
        "SELECT id, username, display_name, password_salt, password_hash, role, status, balance_units, NULL, NULL, created_at FROM users"
      )
      database.execute("DROP TABLE users")
      database.execute("ALTER TABLE users_role_migrated RENAME TO users")
    ensure
      database.execute("PRAGMA legacy_alter_table = OFF")
      database.execute("PRAGMA foreign_keys = ON")
    end
  end

  # INSERT OR IGNORE 在 PostgreSQL 中写作 ON CONFLICT DO NOTHING
  def insert_ignore(table, columns, binds)
    placeholders = database.sqlite? ? (["?"] * columns.length).join(", ") : (1..columns.length).map { |index| "$#{index}" }.join(", ")
    clause = database.sqlite? ? "INSERT OR IGNORE INTO" : "INSERT INTO"
    conflict = database.sqlite? ? "" : " ON CONFLICT DO NOTHING"
    execute("#{clause} #{table} (#{columns.join(', ')}) VALUES (#{placeholders})#{conflict}", *binds)
  end

  def seed_defaults
    POOL_DEFAULTS.each do |level, name, minimum, entry, duration, profit, probability|
      insert_ignore(
        "pool_configs",
        %w[level name minimum_units entry_units duration_seconds profit_percent win_probability_bp],
        [level, name, minimum * 100, entry * 100, duration, profit, probability]
      )
    end
    GIFT_DEFAULTS.each do |slug, name, english, category|
      insert_ignore("gifts", %w[slug name english category], [slug, name, english, category])
    end
  end

  def bootstrap_admin
    username = (ENV["GRAM_ADMIN_USERNAME"].to_s.strip.downcase.empty? ? DEFAULT_ADMIN_USERNAME : ENV["GRAM_ADMIN_USERNAME"].to_s.strip.downcase)
    password = (ENV["GRAM_ADMIN_PASSWORD"].to_s.empty? ? DEFAULT_ADMIN_PASSWORD : ENV["GRAM_ADMIN_PASSWORD"].to_s)
    raise "Admin password must be at least 12 characters." if password.length < 12
    raise "Admin username must use 3-24 letters, digits, dots, underscores, or hyphens." unless valid_username?(username)

    salt = SecureRandom.hex(16)
    hash = password_hash(password, salt)
    row = first("SELECT id FROM users WHERE username = ?", username)
    if row
      execute("UPDATE users SET display_name = ?, password_salt = ?, password_hash = ?, role = 'admin', status = 'active' WHERE id = ?",
              username, salt, hash, row["id"])
    else
      execute("INSERT INTO users (username, display_name, password_salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
              username, username, salt, hash, Time.now.utc.iso8601)
    end
    migrate_invitation_codes
  end

  def migrate_invitation_codes
    users_without_code = execute("SELECT id FROM users WHERE invitation_code IS NULL OR invitation_code = ''")
    users_without_code.each do |user|
      code = generate_invitation_code
      execute("UPDATE users SET invitation_code = ? WHERE id = ?", code, user["id"])
    end
  end

  def valid_username?(username)
    /\A[a-zA-Z0-9._-]{3,24}\z/.match?(username)
  end

  def password_hash(password, salt)
    OpenSSL::PKCS5.pbkdf2_hmac(password, [salt].pack("H*"), PASSWORD_ITERATIONS, 32, "sha256").unpack1("H*")
  end

  def register(username, password, invitation_code = nil)
    normalized = username.to_s.strip.downcase
    raise ApiError.new(422, "用户名需为 3–24 位字母、数字或 . _ -。") unless valid_username?(normalized)
    raise ApiError.new(422, "密码至少需要 8 位。") if password.to_s.length < 8 || password.to_s.length > 128
    raise ApiError.new(503, "管理员尚未配置，暂未开放注册。") if ENV["GRAM_REQUIRE_ADMIN"] == "1" && first("SELECT id FROM users WHERE role = 'admin'").nil?
    raise ApiError.new(409, "这个用户名已注册。") unless first("SELECT id FROM users WHERE username = ?", normalized).nil?

    inviter = nil
    if invitation_code.to_s.strip.empty?
      raise ApiError.new(422, "请填写邀请码后才能注册。")
    else
      inviter = first("SELECT * FROM users WHERE invitation_code = ?", invitation_code.to_s.strip.upcase)
      raise ApiError.new(422, "邀请码无效，请检查后重试。") unless inviter
      raise ApiError.new(422, "邀请人账户已停用。") unless inviter["status"] == "active"
    end

    salt = SecureRandom.hex(16)
    code = generate_invitation_code
    execute("INSERT INTO users (username, display_name, password_salt, password_hash, role, invitation_code, invited_by, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)",
            normalized, username.to_s.strip, salt, password_hash(password, salt), code, inviter ? inviter["id"] : nil, Time.now.utc.iso8601)
    first("SELECT * FROM users WHERE username = ?", normalized)
  rescue SQLite3::ConstraintException
    raise ApiError.new(409, "这个用户名已注册。")
  end

  def authenticate(username, password, ip)
    normalized = username.to_s.strip.downcase
    now = Time.now.to_i
    key = "#{ip}:#{normalized}"
    attempts = @login_attempts[key] ||= []
    attempts.reject! { |timestamp| timestamp < now - 900 }
    raise ApiError.new(429, "登录尝试过多，请 15 分钟后再试。") if attempts.length >= 10

    user = first("SELECT * FROM users WHERE username = ?", normalized)
    valid = user && user["status"] == "active" &&
      secure_compare(password_hash(password.to_s, user["password_salt"]), user["password_hash"])
    unless valid
      attempts << now
      raise ApiError.new(401, "用户名或密码不正确。")
    end
    @login_attempts.delete(key)
    user
  end

  def secure_compare(first_value, second_value)
    return false unless first_value.bytesize == second_value.bytesize
    mismatch = 0
    first_value.bytes.zip(second_value.bytes) { |left, right| mismatch |= left ^ right }
    mismatch.zero?
  end

  def create_session(user)
    token = SecureRandom.urlsafe_base64(32)
    csrf = SecureRandom.urlsafe_base64(24)
    execute("INSERT INTO sessions (token_digest, csrf_token, user_id, expires_at) VALUES (?, ?, ?, ?)",
            OpenSSL::Digest::SHA256.hexdigest(token), csrf, user["id"], Time.now.to_i + SESSION_TTL)
    [token, csrf]
  end

  def session_for(token)
    return nil if token.to_s.empty?
    digest = OpenSSL::Digest::SHA256.hexdigest(token)
    session = first(
      "SELECT sessions.csrf_token, users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_digest = ? AND sessions.expires_at > ?",
      digest, Time.now.to_i
    )
    return nil unless session && session["status"] == "active"
    session
  end

  def logout(token)
    return if token.to_s.empty?
    execute("DELETE FROM sessions WHERE token_digest = ?", OpenSSL::Digest::SHA256.hexdigest(token))
  end

  def public_user(user)
    { id: user["id"], username: user["username"], displayName: user["display_name"], role: user["role"], balanceUnits: user["balance_units"], invitationCode: user["invitation_code"], invitedBy: user["invited_by"] }
  end

  def pool_rules
    execute("SELECT * FROM pool_configs ORDER BY level").map do |row|
      {
        level: row["level"], name: row["name"], minimumUnits: row["minimum_units"],
        entryUnits: row["entry_units"], duration: row["duration_seconds"],
        profitPercent: row["profit_percent"], winProbabilityBp: row["win_probability_bp"],
        enabled: row["enabled"] == 1
      }
    end
  end

  def gift_catalog(include_inactive: false)
    sql = "SELECT * FROM gifts"
    sql += " WHERE active = 1" unless include_inactive
    execute("#{sql} ORDER BY english COLLATE NOCASE").map { |gift| public_gift(gift) }
  end

  def public_gift(gift)
    { slug: gift["slug"], name: gift["name"], english: gift["english"], category: gift["category"], active: gift["active"] == 1 }
  end

  def accrue(holding, now)
    return holding["earned_units"] if holding["status"] == "owned" || holding["started_at"] <= 0
    elapsed = [now - holding["started_at"], 0].max
    rate = holding["status"] == "rental" ? RENTAL_DAILY_RATE / 86_400.0 : INTEREST_ANNUAL_RATE / (365.0 * 86_400)
    holding["earned_units"] + (DEMO_COLLECTIBLE_VALUE * rate * elapsed).floor
  end

  def settle_due_rounds(user_id)
    due = execute("SELECT * FROM rounds WHERE user_id = ? AND settled_at IS NULL AND ends_at <= ?", user_id, Time.now.to_i)
    due.each do |round|
      transaction do
        current = first("SELECT * FROM rounds WHERE id = ? AND settled_at IS NULL", round["id"])
        next unless current
        if current["result"] == 1
          execute("UPDATE users SET balance_units = balance_units + ? WHERE id = ?",
                  current["stake_units"] + current["profit_units"], user_id)
        end
        execute("UPDATE rounds SET settled_at = ? WHERE id = ?", Time.now.to_i, current["id"])
        execute("INSERT INTO wallet_events (user_id, kind, amount_units, created_at) VALUES (?, ?, ?, ?)",
                user_id, current["result"] == 1 ? "mint-win" : "mint-loss",
                current["result"] == 1 ? current["profit_units"] : current["stake_units"], Time.now.utc.iso8601)
      end
    end
  end

  def public_round(round)
    settled = !round["settled_at"].nil?
    {
      id: round["id"], level: round["level"], betAmount: round["stake_units"],
      profitAmount: settled ? round["profit_units"] : nil, method: round["method"],
      won: settled ? round["result"] == 1 : nil, startedAt: round["started_at"] * 1000,
      endsAt: settled ? 0 : round["ends_at"] * 1000, settled: settled, completed: settled,
      winProbabilityBp: round["win_probability_bp"], profitPercent: round["profit_percent"],
      fairnessCommitment: round["fairness_commitment"],
      fairnessSecret: settled ? round["fairness_secret"] : nil,
      fairnessNonce: settled ? round["fairness_nonce"] : nil,
      fairnessDraw: settled ? round["fairness_draw"] : nil
    }
  end

  def state(user)
    settle_due_rounds(user["id"])
    fresh_user = first("SELECT * FROM users WHERE id = ?", user["id"])
    pending_withdraw = first(
      "SELECT COALESCE(SUM(amount_units), 0) AS total FROM wallet_requests WHERE user_id = ? AND kind = 'withdraw' AND status = 'pending'",
      user["id"]
    )["total"]
    rounds = execute("SELECT * FROM rounds WHERE user_id = ? ORDER BY started_at DESC", user["id"])
    history = execute("SELECT * FROM wallet_events WHERE user_id = ? ORDER BY id DESC LIMIT 20", user["id"]).map do |row|
      { kind: row["kind"], amount: row["amount_units"], createdAt: row["created_at"] }
    end
    holdings = execute("SELECT holdings.*, gifts.name, gifts.english FROM holdings JOIN gifts ON gifts.slug = holdings.slug WHERE holdings.user_id = ? ORDER BY holdings.rowid DESC", user["id"]).map do |row|
      {
        id: row["id"], slug: row["slug"], status: row["status"], startedAt: row["started_at"] * 1000,
        earnedUnits: row["earned_units"], itemName: row["name"], english: row["english"]
      }
    end
    {
      user: public_user(fresh_user).merge(pendingWithdrawUnits: pending_withdraw),
      csrfToken: user["csrf_token"],
      poolRules: pool_rules, gifts: gift_catalog, rounds: rounds.map { |round| public_round(round) },
      walletHistory: history, walletRequests: user_wallet_requests(user["id"]), holdings: holdings,
      depositAddresses: public_deposit_addresses
    }
  end

  def create_round(user, body)
    level = integer_param(body["level"], "铸造池等级", 1, 8)
    method = integer_param(body["method"], "铸造方式", 1, 2)
    stake = integer_param(body["amountUnits"], "下注金额", 1, 2_000_000_000)
    config = first("SELECT * FROM pool_configs WHERE level = ?", level)
    raise ApiError.new(422, "该铸造池当前不可用。") unless config && config["enabled"] == 1
    raise ApiError.new(422, "下注金额低于本池最低金额。") if stake < config["minimum_units"]
    active = first("SELECT id FROM rounds WHERE user_id = ? AND level = ? AND settled_at IS NULL", user["id"], level)
    raise ApiError.new(409, "该铸造池已有进行中的轮次。") if active

    round_id = SecureRandom.uuid
    started = Time.now.to_i
    secret = SecureRandom.hex(32)
    commitment = OpenSSL::Digest::SHA256.hexdigest(secret)
    nonce, draw = fairness_roll(secret, round_id)
    won = draw < config["win_probability_bp"]
    profit = (stake * config["profit_percent"] / 100.0).round

    transaction do
      current = first("SELECT * FROM users WHERE id = ?", user["id"])
      reserved = first("SELECT COALESCE(SUM(stake_units), 0) AS total FROM rounds WHERE user_id = ? AND settled_at IS NULL", user["id"])["total"]
      total_balance = current["balance_units"] + reserved.to_i
      raise ApiError.new(403, "账户总额未达到本池门槛。") if total_balance < config["entry_units"]
      raise ApiError.new(422, "可用余额不足。") if current["balance_units"] < stake
      execute("UPDATE users SET balance_units = balance_units - ? WHERE id = ?", stake, user["id"])
      execute(
        "INSERT INTO rounds (id, user_id, level, stake_units, profit_units, method, win_probability_bp, profit_percent, result, started_at, ends_at, fairness_secret, fairness_commitment, fairness_nonce, fairness_draw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        round_id, user["id"], level, stake, profit, method, config["win_probability_bp"], config["profit_percent"],
        won ? 1 : 0, started, started + config["duration_seconds"], secret, commitment, nonce, draw
      )
    end
    public_round(first("SELECT * FROM rounds WHERE id = ?", round_id))
  end

  def fairness_roll(secret, round_id)
    nonce = 0
    limit = (1 << 256) / 10_000 * 10_000
    loop do
      value = OpenSSL::Digest::SHA256.hexdigest("#{secret}:#{round_id}:#{nonce}").to_i(16)
      return [nonce, value % 10_000] if value < limit
      nonce += 1
    end
  end

  def integer_param(value, label, minimum, maximum)
    number = Integer(value)
    raise ApiError.new(422, "#{label}无效。") if number < minimum || number > maximum
    number
  rescue ArgumentError, TypeError
    raise ApiError.new(422, "#{label}无效。")
  end

  def create_wallet_request(user, kind, units, address = nil)
    raise ApiError.new(422, "充值或提现类型无效。") unless %w[deposit withdraw].include?(kind)
    amount = integer_param(units, "金额", 1, 2_000_000_000)
    destination = address.to_s.strip
    if kind == "withdraw"
      raise ApiError.new(422, "请填写有效的收款信息。") unless (8..128).cover?(destination.length)
    else
      raise ApiError.new(422, "请先选择充值地址。") if !destination.empty? && !(1..200).cover?(destination.length)
    end
    request_id = SecureRandom.uuid
    now = Time.now.utc.iso8601
    transaction do
      current = first("SELECT * FROM users WHERE id = ?", user["id"])
      if kind == "withdraw"
        raise ApiError.new(422, "可用余额不足。") if current["balance_units"] < amount
        execute("UPDATE users SET balance_units = balance_units - ? WHERE id = ?", amount, user["id"])
      end
      execute(
        "INSERT INTO wallet_requests (id, user_id, kind, amount_units, address, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        request_id, user["id"], kind, amount, destination.empty? ? nil : destination, now
      )
    end
    request_id
  end

  def user_wallet_requests(user_id)
    execute(
      "SELECT id, kind, amount_units, status, created_at, resolved_at, resolution_note FROM wallet_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      user_id
    ).map do |entry|
      {
        id: entry["id"], kind: entry["kind"], amountUnits: entry["amount_units"],
        status: entry["status"], createdAt: entry["created_at"],
        resolvedAt: entry["resolved_at"], resolutionNote: entry["resolution_note"]
      }
    end
  end

  def resolve_wallet_request(actor, request_id, decision, note)
    raise ApiError.new(403, "需要管理员或代理权限。") unless %w[admin agent].include?(actor["role"])
    raise ApiError.new(422, "审核操作无效。") unless %w[approve cancel].include?(decision)
    reason = note.to_s.strip
    raise ApiError.new(422, "请填写 3–200 个字符的审核备注。") unless (3..200).cover?(reason.length)
    request = nil
    transaction do
      request = first("SELECT * FROM wallet_requests WHERE id = ?", request_id)
      raise ApiError.new(404, "资金申请不存在。") unless request
      raise ApiError.new(409, "该申请已处理，不能重复审核。") unless request["status"] == "pending"
      if actor["role"] == "agent"
        owner = first("SELECT role, invited_by FROM users WHERE id = ?", request["user_id"])
        raise ApiError.new(403, "只能审核自己名下用户的申请。") unless owner && owner["role"] == "user" && owner["invited_by"] == actor["id"]
      end
      now = Time.now.utc.iso8601
      if decision == "approve"
        if request["kind"] == "deposit"
          user = first("SELECT balance_units FROM users WHERE id = ?", request["user_id"])
          new_balance = user["balance_units"] + request["amount_units"]
          raise ApiError.new(422, "确认后余额超出账户可记录范围。") if new_balance > 9_000_000_000_000
          execute("UPDATE users SET balance_units = ? WHERE id = ?", new_balance, request["user_id"])
        end
        execute(
          "INSERT INTO wallet_events (user_id, kind, amount_units, created_at) VALUES (?, ?, ?, ?)",
          request["user_id"], request["kind"], request["amount_units"], now
        )
      elsif request["kind"] == "withdraw"
        execute("UPDATE users SET balance_units = balance_units + ? WHERE id = ?",
                request["amount_units"], request["user_id"])
        execute(
          "INSERT INTO wallet_events (user_id, kind, amount_units, created_at) VALUES (?, 'withdraw-release', ?, ?)",
          request["user_id"], request["amount_units"], now
        )
      end
      status = decision == "approve" ? "approved" : "cancelled"
      execute(
        "UPDATE wallet_requests SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ? AND status = 'pending'",
        status, now, actor["id"], reason, request_id
      )
    end
    audit(actor, "wallet_request_#{decision}", {
      requestId: request_id, userId: request["user_id"], kind: request["kind"],
      amountUnits: request["amount_units"], reason: reason
    })
  end

  def add_holding(user, slug)
    gift = first("SELECT * FROM gifts WHERE slug = ? AND active = 1", slug.to_s)
    raise ApiError.new(404, "该礼物当前不可加入典藏。") unless gift
    id = SecureRandom.uuid
    execute("INSERT INTO holdings (id, user_id, slug, status, started_at) VALUES (?, ?, ?, 'owned', 0)",
            id, user["id"], slug)
    id
  end

  def update_holding(user, id, status)
    raise ApiError.new(422, "典藏状态无效。") unless %w[owned rental interest].include?(status)
    holding = first("SELECT * FROM holdings WHERE id = ? AND user_id = ?", id, user["id"])
    raise ApiError.new(404, "典藏品不存在。") unless holding
    now = Time.now.to_i
    earned = status == "owned" ? accrue(holding, now) : holding["earned_units"]
    started = status == "owned" ? 0 : (status == holding["status"] ? holding["started_at"] : now)
    execute("UPDATE holdings SET status = ?, earned_units = ?, started_at = ? WHERE id = ?",
            status, earned, started, id)
  end

  def claim_earnings(user)
    now = Time.now.to_i
    rows = execute("SELECT * FROM holdings WHERE user_id = ?", user["id"])
    total = rows.sum { |row| accrue(row, now) }
    raise ApiError.new(422, "当前暂无可领取的收益。") if total <= 0
    transaction do
      rows.each do |row|
        started = row["status"] == "owned" ? 0 : now
        execute("UPDATE holdings SET earned_units = 0, started_at = ? WHERE id = ?", started, row["id"])
      end
      execute("UPDATE users SET balance_units = balance_units + ? WHERE id = ?", total, user["id"])
      execute("INSERT INTO wallet_events (user_id, kind, amount_units, created_at) VALUES (?, 'collectible-reward', ?, ?)",
              user["id"], total, Time.now.utc.iso8601)
    end
    total
  end

  def audit(admin, action, detail)
    execute("INSERT INTO admin_audit (admin_id, action, detail_json, created_at) VALUES (?, ?, ?, ?)",
            admin["id"], action, JSON.generate(detail), Time.now.utc.iso8601)
  end

  # ---------- 后台分页公共方法 ----------
  def page_meta(count, page, per_page = ADMIN_PAGE_SIZE)
    total_pages = count.zero? ? 1 : ((count + per_page - 1) / per_page)
    current = page.to_i
    current = 1 if current < 1
    current = total_pages if current > total_pages
    { page: current, totalPages: total_pages, total: count, perPage: per_page }
  end

  def build_filters(options, columns, scope = ["", []])
    scope_sql, scope_params = scope
    conditions = []
    params = scope_params.dup
    query = options[:q].to_s.strip.downcase
    unless query.empty?
      conditions.push(columns[:query])
      pattern = "%#{query}%"
      params.push(pattern, pattern)
    end
    %i[status role kind].each do |key|
      value = options[key].to_s
      next if value.empty? || value == "all"
      column = columns[key]
      next unless column
      if value == "flagged"
        conditions.push("rounds.risk_flag = 1")
      elsif value == "clear"
        conditions.push("rounds.risk_flag = 0")
      else
        conditions.push("#{column} = ?")
        params.push(value)
      end
    end
    sql = conditions.empty? ? "" : " AND #{conditions.join(' AND ')}"
    [scope_sql + sql, params]
  end

  def paginated(base_sql, count_sql, order, mapper, filter_sql, params, page)
    where = filter_sql.strip.empty? ? "" : "WHERE 1=1 #{filter_sql}"
    count = first("#{count_sql} #{where}", *params)["count"]
    meta = page_meta(count, page)
    offset = (meta[:page] - 1) * meta[:perPage]
    rows = execute("#{base_sql} #{where} #{order} LIMIT ? OFFSET ?", *(params + [meta[:perPage], offset]))
    { items: rows.map(&mapper) }.merge(meta)
  end

  def serialize_user_row(row)
    {
      id: row["id"], username: row["username"], displayName: row["display_name"], role: row["role"],
      status: row["status"], balanceUnits: row["balance_units"], invitationCode: row["invitation_code"],
      invitedBy: row["invited_by"], createdAt: row["created_at"]
    }
  end

  def serialize_holding_row(row)
    {
      id: row["id"], userId: row["user_id"], username: row["username"], slug: row["slug"],
      name: row["name"], english: row["english"], status: row["status"],
      startedAt: row["started_at"] * 1000
    }
  end

  def serialize_round_row(row)
    {
      id: row["id"], userId: row["user_id"], username: row["username"], level: row["level"],
      betAmount: row["stake_units"], profitAmount: row["profit_units"],
      won: row["settled_at"] ? row["result"] == 1 : nil,
      winProbabilityBp: row["win_probability_bp"], profitPercent: row["profit_percent"],
      startedAt: row["started_at"] * 1000, endsAt: row["ends_at"] * 1000,
      settled: !row["settled_at"].nil?, fairnessCommitment: row["fairness_commitment"],
      riskFlag: row["risk_flag"] == 1, riskNote: row["risk_note"],
      forcedOutcome: row["forced_outcome"]
    }
  end

  def serialize_wallet_event_row(row)
    {
      id: row["id"], userId: row["user_id"], username: row["username"], kind: row["kind"],
      amountUnits: row["amount_units"], createdAt: row["created_at"]
    }
  end

  def serialize_wallet_request_row(row)
    {
      id: row["id"], userId: row["user_id"], username: row["username"], kind: row["kind"],
      amountUnits: row["amount_units"], address: row["address"], status: row["status"],
      createdAt: row["created_at"], resolvedAt: row["resolved_at"],
      resolutionNote: row["resolution_note"], resolvedBy: row["resolved_by"]
    }
  end

  def serialize_audit_row(row)
    {
      id: row["id"], admin: row["admin"], action: row["action"],
      detail: JSON.parse(row["detail_json"]), createdAt: row["created_at"]
    }
  end

  USER_COLUMNS = "users.id, users.username, users.display_name, users.role, users.status, users.balance_units, users.invitation_code, users.invited_by, users.created_at"

  def users_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR CAST(users.id AS TEXT) LIKE ?)",
      status: "users.status",
      role: "users.role",
    }, scope)
    paginated(
      "SELECT #{USER_COLUMNS} FROM users",
      "SELECT COUNT(*) AS count FROM users",
      "ORDER BY users.id DESC",
      ->(row) { serialize_user_row(row) },
      filter_sql, params, page
    )
  end

  def agents_page(page, options = {}, scope = ["", []])
    users_page(page, options.merge(role: "agent"), scope)
  end

  def rounds_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR rounds.id LIKE ?)",
    }, scope)
    paginated(
      "SELECT rounds.id, rounds.user_id, users.username, rounds.level, rounds.stake_units, rounds.profit_units, rounds.result, rounds.win_probability_bp, rounds.profit_percent, rounds.started_at, rounds.ends_at, rounds.settled_at, rounds.fairness_commitment, rounds.risk_flag, rounds.risk_note, rounds.forced_outcome FROM rounds JOIN users ON users.id = rounds.user_id",
      "SELECT COUNT(*) AS count FROM rounds JOIN users ON users.id = rounds.user_id",
      "ORDER BY rounds.started_at DESC, rounds.id DESC",
      ->(row) { serialize_round_row(row) },
      filter_sql, params, page
    )
  end

  def holdings_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR holdings.id LIKE ?)",
    }, scope)
    paginated(
      "SELECT holdings.id, holdings.user_id, users.username, gifts.slug, gifts.name, gifts.english, holdings.status, holdings.started_at FROM holdings JOIN users ON users.id = holdings.user_id JOIN gifts ON gifts.slug = holdings.slug",
      "SELECT COUNT(*) AS count FROM holdings JOIN users ON users.id = holdings.user_id JOIN gifts ON gifts.slug = holdings.slug",
      "ORDER BY holdings.id DESC",
      ->(row) { serialize_holding_row(row) },
      filter_sql, params, page
    )
  end

  def wallet_events_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR CAST(wallet_events.id AS TEXT) LIKE ?)",
      kind: "wallet_events.kind",
    }, scope)
    paginated(
      "SELECT wallet_events.id, wallet_events.user_id, users.username, wallet_events.kind, wallet_events.amount_units, wallet_events.created_at FROM wallet_events JOIN users ON users.id = wallet_events.user_id",
      "SELECT COUNT(*) AS count FROM wallet_events JOIN users ON users.id = wallet_events.user_id",
      "ORDER BY wallet_events.id DESC",
      ->(row) { serialize_wallet_event_row(row) },
      filter_sql, params, page
    )
  end

  def wallet_requests_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR wallet_requests.id LIKE ?)",
      status: "wallet_requests.status",
      kind: "wallet_requests.kind",
    }, scope)
    paginated(
      "SELECT wallet_requests.id, wallet_requests.user_id, users.username, wallet_requests.kind, wallet_requests.amount_units, wallet_requests.address, wallet_requests.status, wallet_requests.created_at, wallet_requests.resolved_at, wallet_requests.resolution_note, admins.username AS resolved_by FROM wallet_requests JOIN users ON users.id = wallet_requests.user_id LEFT JOIN users AS admins ON admins.id = wallet_requests.resolved_by",
      "SELECT COUNT(*) AS count FROM wallet_requests JOIN users ON users.id = wallet_requests.user_id",
      "ORDER BY CASE wallet_requests.status WHEN 'pending' THEN 0 ELSE 1 END, wallet_requests.created_at DESC, wallet_requests.id DESC",
      ->(row) { serialize_wallet_request_row(row) },
      filter_sql, params, page
    )
  end

  def audit_page(page, options = {}, scope = ["", []])
    filter_sql, params = build_filters(options, {
      query: "(LOWER(users.username) LIKE ? OR CAST(admin_audit.id AS TEXT) LIKE ?)",
    }, scope)
    paginated(
      "SELECT admin_audit.*, users.username FROM admin_audit JOIN users ON users.id = admin_audit.admin_id",
      "SELECT COUNT(*) AS count FROM admin_audit JOIN users ON users.id = admin_audit.admin_id",
      "ORDER BY admin_audit.id DESC",
      ->(row) { serialize_audit_row(row) },
      filter_sql, params, page
    )
  end

  def users_under(user, options = {})
    if user["role"] == "admin"
      users_page(options[:page] || 1, options)
    else
      users_page(options[:page] || 1, options, ["AND users.invited_by = ?", [user["id"]]])
    end
  end

  def agent_dashboard(user, options = {})
    scope = ["AND users.invited_by = ?", [user["id"]]]
    sub_scope = ["AND rounds.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [user["id"]]]
    event_scope = ["AND wallet_events.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [user["id"]]]
    request_scope = ["AND wallet_requests.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [user["id"]]]
    holding_scope = ["AND holdings.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [user["id"]]]
    user_count = first("SELECT COUNT(*) AS count FROM users WHERE 1=1 #{scope[0]}", *scope[1])["count"]
    active_count = first("SELECT COUNT(*) AS count FROM users WHERE status = 'active' #{scope[0]}", *scope[1])["count"]
    suspended_count = user_count - active_count
    round_count = first("SELECT COUNT(*) AS count FROM rounds WHERE 1=1 #{sub_scope[0]}", *sub_scope[1])["count"]
    open_rounds = first("SELECT COUNT(*) AS count FROM rounds WHERE settled_at IS NULL #{sub_scope[0]}", *sub_scope[1])["count"]
    wallet_event_count = first("SELECT COUNT(*) AS count FROM wallet_events WHERE 1=1 #{event_scope[0]}", *event_scope[1])["count"]
    wallet_volume = first("SELECT COALESCE(SUM(amount_units), 0) AS volume FROM wallet_events WHERE 1=1 #{event_scope[0]}", *event_scope[1])["volume"]
    pending_requests = first("SELECT COUNT(*) AS count FROM wallet_requests WHERE status = 'pending' #{request_scope[0]}", *request_scope[1])["count"]
    total_balance = first("SELECT COALESCE(SUM(balance_units), 0) AS total FROM users WHERE 1=1 #{scope[0]}", *scope[1])["total"]
    {
      stats: {
        userCount: user_count, activeUsers: active_count, suspendedUsers: suspended_count,
        totalBalanceUnits: total_balance, roundCount: round_count, openRounds: open_rounds,
        walletEventCount: wallet_event_count, walletVolumeUnits: wallet_volume,
        pendingWalletRequests: pending_requests
      },
      users: users_page(options[:page] || 1, options, scope),
      poolRules: pool_rules,
      gifts: gift_catalog(include_inactive: true),
      holdings: holdings_page(options[:holdingsPage] || 1, {}, holding_scope),
      rounds: rounds_page(options[:page] || 1, options, sub_scope),
      walletEvents: wallet_events_page(options[:walletPage] || 1, options, event_scope),
      walletRequests: wallet_requests_page(options[:walletPage] || 1, options, request_scope),
      audit: { items: [], page: 1, totalPages: 1, total: 0, perPage: ADMIN_PAGE_SIZE },
      viewer: { role: "agent", invitationCode: user["invitation_code"] }
    }
  end

  def set_user_status(actor, user_id, status, reason)
    raise ApiError.new(422, "用户状态无效。") unless %w[active suspended].include?(status)
    raise ApiError.new(403, "需要管理员或代理权限。") unless %w[admin agent].include?(actor["role"])
    note = reason.to_s.strip
    raise ApiError.new(422, "请填写 3–200 个字符的操作原因。") unless (3..200).cover?(note.length)
    user = first("SELECT * FROM users WHERE id = ?", user_id)
    raise ApiError.new(404, "用户不存在。") unless user
    if actor["role"] == "agent"
      raise ApiError.new(403, "只能管理自己名下的普通用户。") unless user["invited_by"] == actor["id"] && user["role"] == "user"
    else
      raise ApiError.new(422, "不能停用最后一个管理员账户。") if user["role"] == "admin" && status == "suspended"
    end
    execute("UPDATE users SET status = ? WHERE id = ?", status, user_id)
    audit(actor, "user_status", { userId: user_id, status: status, reason: note })
  end

  # ---------- 充值地址管理 ----------
  def validate_address_fields(body, partial = false)
    label = body["label"].to_s.strip
    address = body["address"].to_s.strip
    note = body["note"].to_s.strip
    raise ApiError.new(422, "请填写地址名称（1–40 个字符）。") if !partial && !(1..40).cover?(label.length)
    raise ApiError.new(422, "请填写充值地址（4–160 个字符）。") if !partial && !(4..160).cover?(address.length)
    raise ApiError.new(422, "充值地址不能包含空格或换行。") if address.match?(/\s/)
    raise ApiError.new(422, "备注不能超过 200 个字符。") if note.length > 200
    [label, address, note]
  end

  def public_deposit_addresses
    execute(
      "SELECT id, label, address, note FROM deposit_addresses WHERE active = 1 ORDER BY sort_order ASC, id ASC"
    ).map do |row|
      { id: row["id"], label: row["label"], address: row["address"], note: row["note"] }
    end
  end

  def admin_deposit_addresses
    execute(
      "SELECT id, label, address, note, active, sort_order, created_at FROM deposit_addresses ORDER BY sort_order ASC, id ASC"
    ).map do |row|
      {
        id: row["id"], label: row["label"], address: row["address"], note: row["note"],
        active: row["active"] == 1, sortOrder: row["sort_order"], createdAt: row["created_at"]
      }
    end
  end

  def create_deposit_address(admin, body)
    label, address, note = validate_address_fields(body)
    active = body["active"] == false ? 0 : 1
    sort_order = first("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM deposit_addresses")["next"]
    now = Time.now.utc.iso8601
    if database.postgres?
      row = execute(
        "INSERT INTO deposit_addresses (label, address, note, active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        label, address, note, active, sort_order, now
      ).first
      address_id = row["id"]
    else
      execute(
        "INSERT INTO deposit_addresses (label, address, note, active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        label, address, note, active, sort_order, now
      )
      address_id = database.last_insert_row_id
    end
    audit(admin, "deposit_address_create", { id: address_id, label: label, address: address, active: active == 1 })
    first("SELECT * FROM deposit_addresses WHERE id = ?", address_id)
  rescue SQLite3::ConstraintException
    raise ApiError.new(422, "地址名称需 1–40 个字符，充值地址需 4–160 个字符。")
  end

  def update_deposit_address(admin, address_id, body)
    record = first("SELECT * FROM deposit_addresses WHERE id = ?", address_id)
    raise ApiError.new(404, "充值地址不存在。") unless record
    label, address, note = validate_address_fields({
      "label" => body["label"].nil? ? record["label"] : body["label"],
      "address" => body["address"].nil? ? record["address"] : body["address"],
      "note" => body["note"].nil? ? record["note"] : body["note"],
    })
    active = body["active"].nil? ? record["active"] : (body["active"] ? 1 : 0)
    execute(
      "UPDATE deposit_addresses SET label = ?, address = ?, note = ?, active = ? WHERE id = ?",
      label, address, note, active, address_id
    )
    audit(admin, "deposit_address_update", {
      id: address_id, label: label, address: address, active: active == 1
    })
    first("SELECT * FROM deposit_addresses WHERE id = ?", address_id)
  end

  def set_deposit_address_active(admin, address_id, active)
    record = first("SELECT * FROM deposit_addresses WHERE id = ?", address_id)
    raise ApiError.new(404, "充值地址不存在。") unless record
    raise ApiError.new(422, "请明确设置启用状态。") unless [true, false].include?(active)
    execute("UPDATE deposit_addresses SET active = ? WHERE id = ?", active ? 1 : 0, address_id)
    audit(admin, "deposit_address_status", { id: address_id, active: active })
  end

  def delete_deposit_address(admin, address_id)
    record = first("SELECT * FROM deposit_addresses WHERE id = ?", address_id)
    raise ApiError.new(404, "充值地址不存在。") unless record
    execute("DELETE FROM deposit_addresses WHERE id = ?", address_id)
    audit(admin, "deposit_address_delete", { id: address_id, label: record["label"], address: record["address"] })
  end

  def create_agent(admin, username, password)
    normalized = username.to_s.strip.downcase
    raise ApiError.new(422, "用户名需为 3–24 位字母、数字或 . _ -。") unless valid_username?(normalized)
    raise ApiError.new(422, "密码至少需要 8 位。") if password.to_s.length < 8 || password.to_s.length > 128
    raise ApiError.new(409, "这个用户名已注册。") unless first("SELECT id FROM users WHERE username = ?", normalized).nil?

    salt = SecureRandom.hex(16)
    code = generate_invitation_code
    execute("INSERT INTO users (username, display_name, password_salt, password_hash, role, invitation_code, invited_by, created_at) VALUES (?, ?, ?, ?, 'agent', ?, NULL, ?)",
            normalized, username.to_s.strip, salt, password_hash(password, salt), code, Time.now.utc.iso8601)
    user = first("SELECT * FROM users WHERE username = ?", normalized)
    audit(admin, "agent_create", { userId: user["id"], username: normalized, invitationCode: code })
    user
  rescue SQLite3::ConstraintException
    raise ApiError.new(409, "这个用户名已注册。")
  end

  def create_user(admin, body)
    normalized = body["username"].to_s.strip.downcase
    password = body["password"].to_s
    display_name = body["displayName"].to_s.strip
    display_name = normalized if display_name.empty?
    parent_id = begin
      Integer(body["invitedBy"])
    rescue ArgumentError, TypeError
      nil
    end

    raise ApiError.new(422, "用户名需为 3–24 位字母、数字或 . _ -。") unless valid_username?(normalized)
    raise ApiError.new(422, "密码至少需要 8 位。") if password.length < 8 || password.length > 128
    raise ApiError.new(409, "这个用户名已注册。") unless first("SELECT id FROM users WHERE username = ?", normalized).nil?
    if parent_id
      parent = first("SELECT id, role, status FROM users WHERE id = ?", parent_id)
      raise ApiError.new(404, "上级用户不存在。") unless parent
      raise ApiError.new(422, "上级用户必须是代理或管理员。") unless %w[agent admin].include?(parent["role"])
      raise ApiError.new(422, "上级账户已停用，暂不能登记用户。") unless parent["status"] == "active"
    end

    salt = SecureRandom.hex(16)
    code = generate_invitation_code
    execute("INSERT INTO users (username, display_name, password_salt, password_hash, role, invitation_code, invited_by, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)",
            normalized, display_name, salt, password_hash(password, salt), code, parent_id, Time.now.utc.iso8601)
    user = first("SELECT * FROM users WHERE username = ?", normalized)
    audit(admin, "user_create", { userId: user["id"], username: normalized, invitationCode: code, invitedBy: parent_id })
    user
  rescue SQLite3::ConstraintException
    raise ApiError.new(409, "这个用户名已注册。")
  end

  def regenerate_invitation_code(admin, user_id)
    user = first("SELECT * FROM users WHERE id = ?", user_id)
    raise ApiError.new(404, "用户不存在。") unless user
    code = generate_invitation_code
    execute("UPDATE users SET invitation_code = ? WHERE id = ?", code, user_id)
    audit(admin, "invitation_regenerate", { userId: user_id, newCode: code })
    code
  end

  def adjust_user_balance(admin, user_id, body)
    delta = Integer(body["deltaUnits"])
    reason = body["reason"].to_s.strip
    raise ApiError.new(422, "余额调整金额不能为零。") if delta.zero?
    raise ApiError.new(422, "余额调整金额过大。") if delta.abs > 2_000_000_000
    raise ApiError.new(422, "请填写 3–200 个字符的调整原因。") unless (3..200).cover?(reason.length)
    transaction do
      user = first("SELECT * FROM users WHERE id = ?", user_id)
      raise ApiError.new(404, "用户不存在。") unless user
      available = user["balance_units"] + delta
      raise ApiError.new(422, "调整后余额不能为负数。") if available < 0
      execute("UPDATE users SET balance_units = ? WHERE id = ?", available, user_id)
      execute(
        "INSERT INTO wallet_events (user_id, kind, amount_units, created_at) VALUES (?, ?, ?, ?)",
        user_id, delta.positive? ? "admin-credit" : "admin-debit", delta.abs, Time.now.utc.iso8601
      )
    end
    audit(admin, "balance_adjustment", { userId: user_id, deltaUnits: delta, reason: reason })
  rescue ArgumentError, TypeError
    raise ApiError.new(422, "余额调整金额无效。")
  end

  def remove_holding(admin, holding_id)
    holding = first("SELECT holdings.id, holdings.user_id, holdings.slug FROM holdings WHERE id = ?", holding_id)
    raise ApiError.new(404, "典藏品不存在。") unless holding
    execute("DELETE FROM holdings WHERE id = ?", holding_id)
    audit(admin, "holding_remove", { userId: holding["user_id"], holdingId: holding_id, slug: holding["slug"] })
  end

  def flag_round(admin, round_id, flagged, reason)
    raise ApiError.new(422, "请明确设置风险标记状态。") unless [true, false].include?(flagged)
    round = first("SELECT id, user_id FROM rounds WHERE id = ?", round_id)
    raise ApiError.new(404, "下注记录不存在。") unless round
    note = reason.to_s.strip
    if flagged && !(3..200).cover?(note.length)
      raise ApiError.new(422, "请填写 3–200 个字符的风险审核原因。")
    end
    execute("UPDATE rounds SET risk_flag = ?, risk_note = ? WHERE id = ?",
            flagged ? 1 : 0, flagged ? note : nil, round_id)
    audit(admin, "round_risk_flag", {
      roundId: round_id, userId: round["user_id"], flagged: flagged,
      reason: flagged ? note : "管理员清除风险标记"
    })
  end

  # 下单干预：对未结算轮次设置包赢 / 包输 / 恢复随机结果
  def force_round_outcome(admin, round_id, outcome)
    raise ApiError.new(422, "干预结果无效，仅支持包赢、包输或恢复。") unless %w[win lose reset].include?(outcome)
    round = first("SELECT * FROM rounds WHERE id = ?", round_id)
    raise ApiError.new(404, "下注记录不存在。") unless round
    raise ApiError.new(409, "该轮次已结算，无法干预结果。") unless round["settled_at"].nil?

    forced = outcome == "reset" ? nil : outcome
    if forced
      execute("UPDATE rounds SET result = ?, forced_outcome = ? WHERE id = ?",
              forced == "win" ? 1 : 0, forced, round_id)
    else
      # 恢复为随机承诺值原本决定的结果
      natural = round["fairness_draw"] < round["win_probability_bp"] ? 1 : 0
      execute("UPDATE rounds SET result = ?, forced_outcome = NULL WHERE id = ?", natural, round_id)
    end
    audit(admin, "round_force_#{outcome}", {
      roundId: round_id, userId: round["user_id"], forcedOutcome: forced,
      reason: case outcome
              when "win" then "管理员设置为包赢"
              when "lose" then "管理员设置为包输"
              else "管理员取消干预，恢复随机结果"
              end
    })
  end

  def update_pool(admin, level, body)
    config = first("SELECT * FROM pool_configs WHERE level = ?", level)
    raise ApiError.new(404, "铸造池不存在。") unless config
    probability = integer_param(body["winProbabilityBp"], "公开胜率（基点）", 0, 10_000)
    profit = integer_param(body["profitPercent"], "收益率", 0, 500)
    minimum_units = integer_param(body["minimumUnits"] || config["minimum_units"], "最低下注金额", 1, 2_000_000_000)
    entry_units = integer_param(body["entryUnits"] || config["entry_units"], "账户门槛", 1, 2_000_000_000)
    duration = integer_param(body["durationSeconds"] || config["duration_seconds"], "倒计时秒数", 1, 86_400)
    enabled = body["enabled"] == true ? 1 : body["enabled"] == false ? 0 : nil
    raise ApiError.new(422, "铸造池状态无效。") if enabled.nil?
    execute("UPDATE pool_configs SET minimum_units = ?, entry_units = ?, duration_seconds = ?, win_probability_bp = ?, profit_percent = ?, enabled = ? WHERE level = ?",
            minimum_units, entry_units, duration, probability, profit, enabled, level)
    audit(admin, "pool_config", {
      level: level, minimumUnits: minimum_units, entryUnits: entry_units, durationSeconds: duration,
      winProbabilityBp: probability, profitPercent: profit, enabled: enabled == 1
    })
  end

  def upsert_gift(admin, slug, body)
    normalized_slug = slug.to_s.downcase
    raise ApiError.new(422, "礼物编号无效。") unless /\A[a-z0-9-]{2,80}\z/.match?(normalized_slug)
    name = body["name"].to_s.strip
    english = body["english"].to_s.strip
    category = body["category"].to_s.strip
    raise ApiError.new(422, "礼物名称、英文名和分类均为必填项。") if [name, english, category].any?(&:empty?)
    raise ApiError.new(422, "礼物字段过长。") if [name, english, category].any? { |value| value.length > 80 }
    active = body["active"] == false ? 0 : body["active"] == true ? 1 : nil
    raise ApiError.new(422, "请明确设置礼物是否上架。") if active.nil?
    execute(
      "INSERT INTO gifts (slug, name, english, category, active) VALUES (?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, english = excluded.english, category = excluded.category, active = excluded.active",
      normalized_slug, name, english, category, active
    )
    audit(admin, "gift_upsert", { slug: normalized_slug, active: active == 1 })
    public_gift(first("SELECT * FROM gifts WHERE slug = ?", normalized_slug))
  end

  def set_gift_active(admin, slug, active)
    gift = first("SELECT * FROM gifts WHERE slug = ?", slug)
    raise ApiError.new(404, "礼物不存在。") unless gift
    execute("UPDATE gifts SET active = ? WHERE slug = ?", active ? 1 : 0, slug)
    audit(admin, "gift_status", { slug: slug, active: active })
  end

  def admin_dashboard(options = {})
    user_count = first("SELECT COUNT(*) AS count FROM users WHERE role = 'user'")["count"]
    agent_count = first("SELECT COUNT(*) AS count FROM users WHERE role = 'agent'")["count"]
    active_users = first("SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'active'")["count"]
    active_agents = first("SELECT COUNT(*) AS count FROM users WHERE role = 'agent' AND status = 'active'")["count"]
    round_stats = first("SELECT COUNT(*) AS total, SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) AS open_count FROM rounds")
    wallet_stats = first("SELECT COUNT(*) AS count, COALESCE(SUM(amount_units), 0) AS volume FROM wallet_events")
    {
      stats: {
        userCount: user_count, activeUsers: active_users, suspendedUsers: user_count - active_users,
        agentCount: agent_count, activeAgents: active_agents, suspendedAgents: agent_count - active_agents,
        totalBalanceUnits: first(
          "SELECT COALESCE(SUM(users.balance_units), 0) + COALESCE((SELECT SUM(amount_units) FROM wallet_requests WHERE kind = 'withdraw' AND status = 'pending'), 0) AS total FROM users WHERE users.role IN ('user', 'agent')"
        )["total"],
        roundCount: round_stats["total"], openRounds: round_stats["open_count"] || 0,
        walletEventCount: wallet_stats["count"], walletVolumeUnits: wallet_stats["volume"],
        pendingWalletRequests: first("SELECT COUNT(*) AS count FROM wallet_requests WHERE status = 'pending'")["count"]
      },
      users: users_page(options[:page] || 1, options),
      agents: agents_page(options[:agentPage] || 1, options),
      poolRules: pool_rules,
      gifts: gift_catalog(include_inactive: true),
      holdings: holdings_page(options[:holdingsPage] || 1, options),
      rounds: rounds_page(options[:roundsPage] || 1, options),
      walletEvents: wallet_events_page(options[:walletPage] || 1, options),
      walletRequests: wallet_requests_page(options[:walletPage] || 1, options),
      audit: audit_page(options[:auditPage] || 1, options),
      viewer: { role: "admin", invitationCode: nil }
    }
  end

  RESOURCE_METHODS = {
    "users" => :users_page,
    "agents" => :agents_page,
    "rounds" => :rounds_page,
    "holdings" => :holdings_page,
    "walletEvents" => :wallet_events_page,
    "walletRequests" => :wallet_requests_page,
    "audit" => :audit_page,
  }.freeze

  def admin_resource(resource, page, options = {})
    method = RESOURCE_METHODS[resource]
    raise ApiError.new(404, "数据资源不存在。") unless method
    send(method, page, options)
  end
end

class GramServer
  def initialize(service)
    @service = service
  end

  def run
    server = WEBrick::HTTPServer.new(
      Port: Integer(ENV.fetch("PORT", "9292")),
      BindAddress: ENV.fetch("BIND_ADDRESS", "127.0.0.1"),
      DocumentRoot: ROOT,
      AccessLog: [],
      Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN),
      DoNotReverseLookup: true
    )
    server.mount("/api", GramApiServlet, self)
    trap("INT") { server.shutdown }
    trap("TERM") { server.shutdown }
    puts "GRAM backend listening at http://#{ENV.fetch('BIND_ADDRESS', '127.0.0.1')}:#{ENV.fetch('PORT', '9292')}"
    puts "Database: #{@service.describe_database}"
    server.start
  end

  def handle(request, response)
    @service.synchronize do
      response["Content-Type"] = "application/json; charset=utf-8"
      response["Cache-Control"] = "no-store"
      response["X-Content-Type-Options"] = "nosniff"
      path = request.path.dup.force_encoding(Encoding::UTF_8).scrub.sub(%r{/+\z}, "")
      path = "/api" if path.empty?
      body = parse_json(request)
      user = authenticate_request(request)
      result = route(request, response, path, body, user)
      response.status = 200
      response.body = JSON.generate(result || { ok: true })
    end
  rescue ApiError => error
    json_error(response, error.status, error.message)
  rescue JSON::ParserError
    json_error(response, 400, "请求内容不是有效 JSON。")
  rescue GRAMDB::ConstraintError
    json_error(response, 409, "数据冲突，请刷新后重试。")
  rescue StandardError => error
    warn "GRAM backend error: #{error.class}: #{error.message}"
    warn error.backtrace.first(5).join("\n") if ENV["GRAM_DEBUG"] == "1"
    json_error(response, 500, "服务暂时无法处理请求。")
  end

  def parse_json(request)
    return {} if request.body.to_s.empty?
    raise ApiError.new(413, "请求内容过大。") if request.body.bytesize > 32_768
    parsed = JSON.parse(request.body)
    raise ApiError.new(400, "请求内容必须是 JSON 对象。") unless parsed.is_a?(Hash)
    parsed
  end

  def pagination_params(request)
    {
      page: request.query["page"].to_s,
      q: request.query["q"].to_s,
      status: request.query["status"].to_s,
      role: request.query["role"].to_s,
      kind: request.query["kind"].to_s,
    }
  end

  def cookie_token(request)
    request.cookies.find { |cookie| cookie.name == "gram_session" }&.value
  end

  def authenticate_request(request)
    session = @service.session_for(cookie_token(request))
    return session unless session
    if MUTATION_METHODS.include?(request.request_method)
      supplied = request["X-CSRF-Token"].to_s
      unless !supplied.empty? && @service.secure_compare(supplied, session["csrf_token"])
        raise ApiError.new(403, "请求校验已过期，请刷新页面后重试。")
      end
    end
    session
  end

  def require_user(user)
    raise ApiError.new(401, "请先登录。") unless user
    raise ApiError.new(403, "该账户已停用。") unless user["status"] == "active"
    user
  end

  def require_admin(user)
    require_user(user)
    raise ApiError.new(403, "需要管理员权限。") unless user["role"] == "admin"
    user
  end

  def route(request, response, path, body, user)
    method = request.request_method
    if method == "GET" && path == "/api/health"
      return { status: "ok", mode: "live", realAssets: true }
    end
    if method == "POST" && path == "/api/register"
      created = @service.register(body["username"], body["password"], body["invitationCode"])
      issue_session(response, created)
      return { user: @service.public_user(created), csrfToken: @csrf_token }
    end
    if method == "POST" && path == "/api/login"
      logged_in = @service.authenticate(body["username"], body["password"], request.peeraddr[3])
      issue_session(response, logged_in)
      return { user: @service.public_user(logged_in), csrfToken: @csrf_token }
    end
    if method == "POST" && path == "/api/logout"
      @service.logout(cookie_token(request))
      clear_session(response)
      return { ok: true }
    end
    if method == "GET" && path == "/api/session"
      current = require_user(user)
      return { user: @service.public_user(current), csrfToken: current["csrf_token"] }
    end
    if method == "GET" && path == "/api/state"
      return @service.state(require_user(user))
    end
    if method == "POST" && path == "/api/wallet/deposit"
      current = require_user(user)
      request_id = @service.create_wallet_request(current, "deposit", body["amountUnits"], body["address"])
      return { requestId: request_id, state: @service.state(current) }
    end
    if method == "POST" && path == "/api/wallet/withdraw"
      current = require_user(user)
      request_id = @service.create_wallet_request(current, "withdraw", body["amountUnits"], body["address"])
      return { requestId: request_id, state: @service.state(current) }
    end
    if method == "POST" && path == "/api/rounds"
      return @service.create_round(require_user(user), body)
    end
    if method == "POST" && path == "/api/holdings"
      current = require_user(user)
      id = @service.add_holding(current, body["slug"])
      return { holdingId: id, state: @service.state(current) }
    end
    if method == "PATCH" && (match = %r{\A/api/holdings/([a-f0-9-]+)\z}.match(path))
      current = require_user(user)
      @service.update_holding(current, match[1], body["status"].to_s)
      return @service.state(current)
    end
    if method == "POST" && path == "/api/holdings/claim"
      current = require_user(user)
      claimed = @service.claim_earnings(current)
      state = @service.state(current)
      state[:claimedUnits] = claimed
      return state
    end
    if method == "GET" && path == "/api/admin"
      admin = require_admin(user)
      return @service.admin_dashboard(pagination_params(request))
    end
    if method == "GET" && path == "/api/agent"
      agent = require_user(user)
      raise ApiError.new(403, "需要代理权限。") unless agent["role"] == "agent"
      return @service.agent_dashboard(agent, pagination_params(request))
    end
    if method == "GET" && path == "/api/admin/list"
      actor = require_user(user)
      resource = request.query["resource"].to_s
      page = request.query["page"].to_s
      options = {
        q: request.query["q"].to_s,
        status: request.query["status"].to_s,
        role: request.query["role"].to_s,
        kind: request.query["kind"].to_s,
      }
      if actor["role"] == "agent"
        raise ApiError.new(403, "只能查看自己名下的用户与订单数据。") unless %w[users rounds walletEvents walletRequests holdings].include?(resource)
        agent_id = actor["id"]
        scoped = {
          "users" => ["AND users.invited_by = ?", [agent_id]],
          "rounds" => ["AND rounds.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [agent_id]],
          "holdings" => ["AND holdings.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [agent_id]],
          "walletEvents" => ["AND wallet_events.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [agent_id]],
          "walletRequests" => ["AND wallet_requests.user_id IN (SELECT id FROM users WHERE invited_by = ?)", [agent_id]],
        }
        method_map = {
          "users" => :users_page, "rounds" => :rounds_page, "holdings" => :holdings_page,
          "walletEvents" => :wallet_events_page, "walletRequests" => :wallet_requests_page,
        }
        return @service.send(method_map[resource], page, options, scoped[resource])
      end
      raise ApiError.new(403, "需要管理员权限。") unless actor["role"] == "admin"
      return @service.admin_resource(resource, page, options)
    end
    if method == "POST" && (match = %r{\A/api/admin/agents\z}.match(path))
      admin = require_admin(user)
      created = @service.create_agent(admin, body["username"], body["password"])
      return { user: @service.public_user(created), csrfToken: @csrf_token }
    end
    if method == "POST" && (match = %r{\A/api/admin/users\z}.match(path))
      admin = require_admin(user)
      created = @service.create_user(admin, body)
      return { user: @service.public_user(created), csrfToken: @csrf_token }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/users/(\d+)/invitation\z}.match(path))
      admin = require_admin(user)
      code = @service.regenerate_invitation_code(admin, match[1].to_i)
      return { invitationCode: code }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/wallet-requests/([a-f0-9-]+)\z}.match(path))
      actor = require_user(user)
      @service.resolve_wallet_request(actor, match[1], body["decision"].to_s, body["reason"])
      return { ok: true }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/users/(\d+)\z}.match(path))
      actor = require_user(user)
      @service.set_user_status(actor, match[1].to_i, body["status"].to_s, body["reason"])
      return { ok: true }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/users/(\d+)/balance\z}.match(path))
      admin = require_admin(user)
      @service.adjust_user_balance(admin, match[1].to_i, body)
      return { ok: true }
    end
    if method == "DELETE" && (match = %r{\A/api/admin/holdings/([a-f0-9-]+)\z}.match(path))
      admin = require_admin(user)
      @service.remove_holding(admin, match[1])
      return { ok: true }
    end
    if method == "GET" && path == "/api/deposit-addresses"
      require_user(user)
      return { addresses: @service.public_deposit_addresses }
    end
    if method == "GET" && path == "/api/admin/deposit-addresses"
      require_admin(user)
      return { addresses: @service.admin_deposit_addresses }
    end
    if method == "POST" && path == "/api/admin/deposit-addresses"
      admin = require_admin(user)
      return { address: @service.create_deposit_address(admin, body) }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/deposit-addresses/(\d+)\z}.match(path))
      admin = require_admin(user)
      return { address: @service.update_deposit_address(admin, match[1].to_i, body) }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/deposit-addresses/(\d+)/status\z}.match(path))
      admin = require_admin(user)
      raise ApiError.new(422, "请明确设置启用状态。") unless [true, false].include?(body["active"])
      @service.set_deposit_address_active(admin, match[1].to_i, body["active"])
      return { ok: true }
    end
    if method == "DELETE" && (match = %r{\A/api/admin/deposit-addresses/(\d+)\z}.match(path))
      admin = require_admin(user)
      @service.delete_deposit_address(admin, match[1].to_i)
      return { ok: true }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/rounds/([a-f0-9-]+)/outcome\z}.match(path))
      admin = require_admin(user)
      @service.force_round_outcome(admin, match[1], body["outcome"].to_s)
      return { ok: true }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/rounds/([a-f0-9-]+)/risk\z}.match(path))
      admin = require_admin(user)
      @service.flag_round(admin, match[1], body["flagged"], body["reason"])
      return { ok: true }
    end
    if method == "PATCH" && (match = %r{\A/api/admin/pools/([1-8])\z}.match(path))
      admin = require_admin(user)
      @service.update_pool(admin, match[1].to_i, body)
      return { ok: true }
    end
    if method == "PUT" && (match = %r{\A/api/admin/gifts/([a-zA-Z0-9-]+)\z}.match(path))
      admin = require_admin(user)
      return @service.upsert_gift(admin, match[1], body)
    end
    if method == "PATCH" && (match = %r{\A/api/admin/gifts/([a-zA-Z0-9-]+)/status\z}.match(path))
      admin = require_admin(user)
      active = body["active"]
      raise ApiError.new(422, "请明确设置上架状态。") unless [true, false].include?(active)
      @service.set_gift_active(admin, match[1], active)
      return { ok: true }
    end
    raise ApiError.new(404, "接口不存在。")
  end

  def issue_session(response, user)
    token, csrf = @service.create_session(user)
    @csrf_token = csrf
    secure = ENV["GRAM_COOKIE_SECURE"] == "1" ? "; Secure" : ""
    response["Set-Cookie"] = "gram_session=#{token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=#{SESSION_TTL}#{secure}"
  end

  def clear_session(response)
    secure = ENV["GRAM_COOKIE_SECURE"] == "1" ? "; Secure" : ""
    response["Set-Cookie"] = "gram_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0#{secure}"
  end

  def json_error(response, status, message)
    response.status = status
    response["Content-Type"] = "application/json; charset=utf-8"
    response["Cache-Control"] = "no-store"
    response.body = JSON.generate({ error: message })
  end
end

class GramApiServlet < WEBrick::HTTPServlet::AbstractServlet
  def initialize(server, api)
    super(server)
    @api = api
  end

  def do_GET(request, response)
    @api.handle(request, response)
  end

  alias do_POST do_GET
  alias do_PATCH do_GET
  alias do_PUT do_GET
  alias do_DELETE do_GET
end

if $PROGRAM_NAME == __FILE__
  GramServer.new(GramService.new).run
end
