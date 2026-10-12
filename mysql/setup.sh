#!/usr/bin/env bash
# =====================================================================
# GRAM 平台 · MySQL 一键初始化
#
# 作用：连接 MySQL → 执行 schema.sql（建表+索引+铸造池种子）
#       → 从 server.rb 提取 24 个礼物种子写入数据库
#       → 创建管理员账户并输出专属邀请码
#
# 用法：./mysql/setup.sh
# 环境变量（均有默认值）：
#   MYSQL_HOST      默认 127.0.0.1
#   MYSQL_PORT      默认 3306
#   MYSQL_USER      默认 root
#   MYSQL_PASSWORD  默认空
#   MYSQL_DATABASE  默认 gram_platform
#   GRAM_ADMIN_USERNAME  默认 admin
#   GRAM_ADMIN_PASSWORD  默认 123123123123（上线前务必修改）
# =====================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { printf "${GREEN}▶${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_DATABASE="${MYSQL_DATABASE:-gram_platform}"
ADMIN_USER="${GRAM_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${GRAM_ADMIN_PASSWORD:-123123123123}"

command -v mysql >/dev/null 2>&1 || die "未找到 mysql 命令。请先安装 MySQL Community Server 并确认已加入 PATH。"
command -v ruby >/dev/null 2>&1 || die "需要 Ruby 来生成礼物种子数据。"
[ ${#ADMIN_PASS} -ge 12 ] || die "管理员密码至少 12 位（当前 ${#ADMIN_PASS} 位）"

MYSQL_CMD=(mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER")
if [ -n "${MYSQL_PASSWORD:-}" ]; then
  MYSQL_CMD+=(-p"$MYSQL_PASSWORD")
fi

say "测试数据库连接（${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}）..."
"${MYSQL_CMD[@]}" -e "SELECT VERSION();" >/dev/null 2>&1 || die "连接失败，请检查 MySQL 是否已启动、账号密码是否正确。"

say "执行建表脚本 mysql/schema.sql ..."
"${MYSQL_CMD[@]}" < "$(dirname "$0")/schema.sql" || die "建表失败"

say "写入礼物种子数据（自动从 server.rb 提取，共 24 项）..."
GIFT_SQL=$(ruby - "$(dirname "$0")/../server.rb" <<'RUBY'
segment = File.read(ARGV[0])[/GIFT_DEFAULTS\s*=\s*\[(.*?)\]\s*\.freeze/m, 1]
gifts = segment.scan(/\["([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\]/)
abort "礼物数量异常：#{gifts.length}" unless gifts.length == 24
values = gifts.map do |slug, name, english, category|
  esc = ->(v) { v.gsub("'", "''") }
  "('#{esc.call(slug)}', '#{esc.call(name)}', '#{esc.call(english)}', '#{esc.call(category)}')"
end
puts "INSERT IGNORE INTO gifts (slug, name, english, category) VALUES #{values.join(', ')};"
RUBY
)
echo "$GIFT_SQL" | "${MYSQL_CMD[@]}" gram_platform || die "礼物种子写入失败"

say "校验礼物数量 ..."
COUNT=$("${MYSQL_CMD[@]}" -N -e "SELECT COUNT(*) FROM gram_platform.gifts;")
[ "$COUNT" -ge 24 ] || warn "礼物数量为 ${COUNT}，少于预期的 24，请检查。"

say "创建管理员账户 ${ADMIN_USER} ..."
SALT=$(ruby -rsecurerandom -e 'puts SecureRandom.hex(16)')
HASH=$(ruby -ropenssl -e 'puts OpenSSL::PKCS5.pbkdf2_hmac(ARGV[0], ARGV[1], 120_000, 32, OpenSSL::Digest::SHA256.new).unpack1("H*")' "$ADMIN_PASS" "$SALT")
CODE=$(ruby -e 'chars = ("A".."Z").to_a + ("0".."9").to_a; puts 5.times.map { chars.sample }.join')

"${MYSQL_CMD[@]}" "gram_platform" <<SQL
INSERT INTO users (username, display_name, password_salt, password_hash, role, status, balance_units, invitation_code, invited_by, created_at)
VALUES ('${ADMIN_USER}', '${ADMIN_USER}', '${SALT}', '${HASH}', 'admin', 'active', 0, '${CODE}', NULL, UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE password_salt = '${SALT}', password_hash = '${HASH}', invitation_code = '${CODE}';
SQL

say "初始化完成！"
cat <<TEXT

  数据库：${MYSQL_DATABASE}
  管理员：${ADMIN_USER}
  邀请码：${CODE}   ← 用户注册时需要填写

  启动平台（二选一）：

    # 方式一：直接指定连接串
    DATABASE_URL="mysql2://${MYSQL_USER}@{你的密码}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}" ruby server.rb

    # 方式二：写入 .env 后 source
    echo 'DATABASE_URL="mysql2://${MYSQL_USER}:@{你的密码}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}"' > .env
    source .env && ruby server.rb

  然后打开 http://127.0.0.1:9292/ ，后台在 /admin.html
TEXT
warn "默认管理员密码仅用于本地开发，对外提供服务前请修改并设置 GRAM_ADMIN_PASSWORD。"
