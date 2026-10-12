#!/usr/bin/env bash
# 创建首个管理员账户（仅在 Supabase 后端首次部署时需要）
#
# 用法：./supabase/seed-admin.sh <用户名> <密码，至少12位>
# 依赖：curl
set -euo pipefail

USERNAME="${1:-}"
PASSWORD="${2:-}"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

say()  { printf "${GREEN}▶${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

[ -n "${USERNAME}" ] || die "请提供管理员用户名"
[ ${#PASSWORD} -ge 12 ] || die "管理员密码至少 12 位"
[ -n "${SUPABASE_URL:-}" ] || die "请设置环境变量 SUPABASE_URL（如 https://xxxx.supabase.co）"
[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || die "请设置环境变量 SUPABASE_SERVICE_ROLE_KEY"

command -v curl >/dev/null 2>&1 || die "未找到 curl"

if ! command -v ruby >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  die "需要 ruby 或 python3 来派生密码哈希"
fi

say "生成盐与 PBKDF2-HMAC-SHA256 哈希（120000 次迭代）..."

if command -v ruby >/dev/null 2>&1; then
  read -r SALT HASH <<<"$(ruby -e '
    require "securerandom"
    require "openssl"
    salt = SecureRandom.hex(16)
    # 注意必须传 Digest 实例；旧版 Ruby 传类会抛 TypeError
    digest = OpenSSL::Digest::SHA256.new
    hash = OpenSSL::PKCS5.pbkdf2_hmac(ARGV[0], salt, 120_000, 32, digest).unpack1("H*")
    puts "#{salt} #{hash}"
  ' "${PASSWORD}")"
else
  read -r SALT HASH <<<"$(python3 -c "
import hashlib, secrets, sys
salt = secrets.token_hex(16)
digest = hashlib.pbkdf2_hmac('sha256', sys.argv[1].encode(), bytes.fromhex(salt), 120000, 32)
print(f'{salt} {digest.hex()}')
" "${PASSWORD}")"
fi

say "插入管理员账户 ${USERNAME} ..."

# 邀请码取 5 位随机字母数字
CODE=$(python3 -c "
import random, string
print(''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(5)))" 2>/dev/null \
  || ruby -e 'chars = ("A".."Z").to_a + ("0".."9").to_a; puts 5.times.map { chars.sample }.join')

HTTP=$(curl -sS -o /tmp/seed_admin.json -w "%{http_code}" -X POST \
  "${SUPABASE_URL}/rest/v1/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
        \"username\": \"${USERNAME}\",
        \"display_name\": \"${USERNAME}\",
        \"password_salt\": \"${SALT}\",
        \"password_hash\": \"${HASH}\",
        \"role\": \"admin\",
        \"status\": \"active\",
        \"balance_units\": 0,
        \"invitation_code\": \"${CODE}\",
        \"invited_by\": null,
        \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
      }" || echo "000")

rm -f /tmp/seed_admin.json

if [ "${HTTP}" = "200" ] || [ "${HTTP}" = "201" ]; then
  say "管理员已创建，邀请码：${CODE}"
  say "现在可以用该用户名密码登录前端与后台（/admin.html）。"
else
  die "创建失败（HTTP ${HTTP}）。若提示 username 重复，说明管理员已存在，可直接登录。"
fi
