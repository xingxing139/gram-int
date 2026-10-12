source "https://rubygems.org"

# Ruby 3.0 起 webrick 已从标准库移除，需显式声明
gem "webrick", "~> 1.8"

# 本地 SQLite 与云 PostgreSQL 双支持
# 说明：直接 `ruby server.rb` 运行时无需 bundler；
# 仅当设置 DATABASE_URL 指向 PostgreSQL 时才会 require "pg"。
gem "sqlite3", "~> 1.6"
gem "pg", "~> 1.5", require: false
