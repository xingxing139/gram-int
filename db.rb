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

    def mysql?
      @kind == :mysql
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

  # SQLite 模式的 `CAST(x AS TEXT)` 在 MySQL 必须写成 `CAST(x AS CHAR)`。
  # 业务层统一按 SQLite 风格书写，这里在 MySQL 执行前统一替换。
  def translate_dialect(sql)
    sql
  end

  # MySQL 适配器
  # 说明：
  #   1. mysql2 不支持 `?` 占位符，这里按「字符串感知」的方式把 ? 替换为
  #      已转义字面量（escape 会正确处理 nil / 数字 / 布尔 / 字符串）
  #   2. 事务用显式 BEGIN / COMMIT / ROLLBACK，配合 SELECT ... FOR UPDATE
  #      行锁，与 Supabase 版存储过程达到同等的并发安全性
  class MySQL < Base
    def initialize(url)
      @kind = :mysql
      require "mysql2"
      require "uri"
      require "cgi"
      uri = URI(url)
      @raw = Mysql2::Client.new(
        host: uri.host || "127.0.0.1",
        port: uri.port || 3306,
        username: uri.user ? CGI.unescape(uri.user) : "root",
        password: uri.password ? CGI.unescape(uri.password) : nil,
        database: uri.path.sub(%r{\A/}, ""),
        encoding: "utf8mb4",
        reconnect: true,
      )
      @in_transaction = false
    end

    # MySQL 方言转换：
    #   CAST(x AS TEXT)  → CAST(x AS CHAR)   （SQLite 写法）
    #   t.rowid          → t.id               （SQLite 伪列，MySQL 用主键）
    #   INSERT OR IGNORE → INSERT IGNORE      （在 server.rb 中另行处理）
    def translate_dialect(sql)
      translated = sql.gsub(/\bAS\s+TEXT\b/i, "AS CHAR")
      translated.gsub(/(\w+)\.rowid\b/i) { "#{Regexp.last_match(1)}.id" }
                 .gsub(/\s+COLLATE\s+NOCASE\b/i, "")
    end

    # mysql2 对 INSERT / UPDATE / DDL 返回 nil，对 SELECT 返回 Result；
    # 统一转成数组，供 Base#execute 的 map 使用。
    def raw_execute(sql, binds)
      result = @raw.query(interpolate(translate_dialect(sql), binds))
      return [] if result.nil?
      result.respond_to?(:to_a) ? result.to_a : Array(result)
    end

    # 把 ? 替换为转义后的字面量；跳过单引号字符串内部的 ?
    def interpolate(sql, binds)
      return sql if binds.nil? || binds.empty?
      values = binds.dup
      output = +""
      index = 0
      in_string = false
      while index < sql.length
        char = sql[index]
        if in_string
          output << char
          if char == "'"
            if sql[index + 1] == "'"
              output << sql[index + 1]
              index += 2
              next
            end
            in_string = false
          end
          index += 1
          next
        end
        if char == "'"
          in_string = true
          output << char
          index += 1
          next
        end
        if char == "?"
          output << escape_literal(values.shift)
          index += 1
          next
        end
        output << char
        index += 1
      end
      output
    end

    # 自行实现 SQL 字面量转义，不依赖 mysql2 各版本不一致的 escape 行为：
    #   nil   -> NULL
    #   布尔  -> 1 / 0
    #   数值  -> 原样
    #   字符串 -> 单引号包裹，内部 \ 变为 \\ ，' 变为 ''
    def escape_literal(value)
      case value
      when nil then "NULL"
      when true then "1"
      when false then "0"
      when Integer, Float then value.to_s
      else escape_string(value.to_s)
      end
    end

    def escape_string(text)
      escaped = text.gsub("\\", "\\\\").gsub("'", "''")
      "'" + escaped + "'"
    end

    def transaction_active?
      @in_transaction
    end

    def last_insert_row_id
      @raw.query("SELECT LAST_INSERT_ID() AS id").first["id"].to_i
    end

    def execute_batch(sql)
      sql.split(";").each do |statement|
        next if statement.strip.empty?
        @raw.query(statement)
      end
    end

    def column_names(table)
      @raw.query(
        "SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS " \
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '#{@raw.escape(table)}' ORDER BY ORDINAL_POSITION"
      ).map { |row| row["name"] }
    end

    def transaction
      raise "nested transactions are not supported" if @in_transaction
      @raw.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
      @raw.query("BEGIN")
      @in_transaction = true
      result = yield
      @raw.query("COMMIT")
      result
    rescue StandardError
      begin
        @raw.query("ROLLBACK") if @in_transaction
      rescue StandardError
        nil
      end
      raise
    ensure
      @in_transaction = false
    end
  end

  def self.build
    url = ENV.fetch("DATABASE_URL", "").to_s.strip
    if url.empty? || url.start_with?("sqlite:")
      path = url.empty? ? ENV.fetch("GRAM_DATABASE", File.join(Dir.pwd, "data", "gram.sqlite3")) : url.sub(/\Asqlite:/, "")
      SQLite.new(path.empty? ? ":memory:" : path)
    elsif url.start_with?("mysql2://", "mysql://")
      MySQL.new(url.sub(/\Amysql:\/\//, "mysql2://"))
    else
      Postgres.new(url)
    end
  end
end
