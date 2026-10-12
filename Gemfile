source "https://rubygems.org"

# Ruby 3.0 起 webrick 已从标准库移除，需显式声明
gem "webrick", "~> 1.8"

# 本地 SQLite 与云 PostgreSQL 双支持
# 说明：直接 `ruby server.rb` 运行时无需 bundler；
# 仅当设置 DATABASE_URL 指向 PostgreSQL 时才会 require "pg"。
gem "sqlite3", "~> 1.6"

# 仅在部署到需要 PostgreSQL 的环境（Docker / 云主机）时安装。
# 分组的目的是让 Replit、本机免 libpq 环境可以用 `bundle install --without postgres`
# 跳过它，此时平台仍以 SQLite 正常运行（db.rb 里 require "pg" 是惰性的）。
group :postgres do
  gem "pg", "~> 1.5"
end
