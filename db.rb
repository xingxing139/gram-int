# 数据库适配层
# 默认使用本地 SQLite（无需任何配置），云部署时设置 DATABASE_URL 即可切换到 PostgreSQL，
# 业务代码无需改动：本层负责连接、占位符转换（? → $n）、事务与结果类型归一。
#
#   DATABASE_URL=postgres://user:pass@host:5432/dbname   # PostgreSQL（Supabase / Render 等）
#   DATABASE_URL=sqlite:./data/gram.sqlite3              # SQLite（本地默认）
#
require "sqlite3"

module GRAMDB
  class ConstraintError < StandardError; end

  # 将 SQLite 风格的 "?" 占位符转换为 PostgreSQL 的 "$1, $2 ..."
  def self.translate_placeholders(sql)
    index = 0
    sql.gsub("?") { index += 1; "$#{index}" }
  end

  class Base
    attr_reader :raw, :kind

    def postgres?
      @kind == :postgres
    end

    def sqlite?
      @kind == :sqlite
    end

    # 业务层统一使用此方法执行查询/写入，返回字符串键的 Hash 数组
    def execute(sql, *binds)
      rows = raw_execute(sql, binds)
      rows.map { |row| normalize(row) }
    end

    def first(sql, *binds)
      rows = execute(sql, *binds)
      rows.empty? ? nil : rows.first
    end

    def transaction
      raw.transaction
      result = yield
      raw.commit
      result
    rescue StandardError
      raw.rollback if transaction_active?
      raise
    end

    def transaction_active?
      raw.transaction_active?
    end

    def close
      raw.close
    end

    def last_insert_row_id
      raw.last_insert_row_id
    end

    def execute_batch(sql)
      raw.execute_batch(sql)
    end

    # 建表/迁移用：返回表的 CREATE 语句（PG 通过 information_schema 无法拿到原文，
    # 因此 PG 会返回空字符串，调用方据此跳过仅用于 SQLite 的迁移）
    def table_sql(table)
      ""
    end

    def column_names(table)
      []
    end

    private

    def normalize(row)
      return row unless row.is_a?(Hash)
      row.each_with_object({}) do |(key, value), result|
        result[key.to_s] = value
      end
    end
  end

  # SQLite 适配器：保持既有行为
  class SQLite < Base
    def initialize(path)
      @kind = :sqlite
      @raw = SQLite3::Database.new(path)
      @raw.results_as_hash = true
      @raw.busy_timeout = 5_000
    end

    def raw_execute(sql, binds)
      raw.execute(sql, binds)
    end

    def table_sql(table)
      row = first("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)
      row ? row["sql"].to_s : ""
    end

    def column_names(table)
      raw.execute("PRAGMA table_info(#{table})").map { |row| row["name"] }
    end
  end

  # PostgreSQL 适配器
  class Postgres < Base
    def initialize(url)
      @kind = :postgres
      require "pg"
      @raw = PG.connect(url)
      # 让整数/布尔等按 Ruby 原生类型返回，与 SQLite 行为保持一致
      @raw.type_map_for_results = PG::BasicTypeMapForResults.new(@raw)
    end

    def raw_execute(sql, binds)
      @raw.exec_params(GRAMDB.translate_placeholders(sql), binds.map { |value| normalize_bind(value) })
    rescue PG::UniqueViolation, PG::CheckViolation, PG::NotNullViolation, PG::ForeignKeyViolation => error
      raise ConstraintError, error.message
    end

    def transaction_active?
      @raw.transaction_status == PG::PQTRANS_INTRANS
    end

    def last_insert_row_id
      @raw.exec("SELECT lastval()").first["lastval"].to_i
    end

    def execute_batch(sql)
      sql.split(";").each do |statement|
        next if statement.strip.empty?
        @raw.exec(statement)
      end
    rescue PG::UniqueViolation, PG::CheckViolation, PG::NotNullViolation, PG::ForeignKeyViolation => error
      raise ConstraintError, error.message
    end

    def column_names(table)
      execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position",
        table.to_s
      ).map { |row| row["column_name"] }
    end

    private

    # PG 不接受 nil 之外的特殊对象；布尔统一转成整数以匹配既有 0/1 语义
    def normalize_bind(value)
      case value
      when true then 1
      when false then 0
      when Float then value
      else value
      end
    end
  end

  def self.build
    url = ENV.fetch("DATABASE_URL", "").to_s.strip
    if url.empty? || url.start_with?("sqlite:")
      path = url.empty? ? ENV.fetch("GRAM_DATABASE", File.join(Dir.pwd, "data", "gram.sqlite3")) : url.sub(/\Asqlite:/, "")
      SQLite.new(path.empty? ? ":memory:" : path)
    else
      Postgres.new(url)
    end
  end
end
