#!/usr/bin/env bash
# =====================================================================
# GRAM 平台 · MySQL 一键启动
#
# 自动完成：检查 MySQL → 未启动则启动 → 校验数据库 → 启动平台
# 用法：./start-mysql.sh
# =====================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;32m'; NC='\033[0m'
say()  { printf "${GREEN}▶${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

# ---- 配置（可按需修改，敏感信息建议用 .env） ----
MYSQL_BIN="${MYSQL_BIN:-/usr/local/mysql/bin}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_DB="${MYSQL_DB:-gram_platform}"
APP_PORT="${APP_PORT:-9292}"

# 从 .env 读取密码（若存在）
if [ -f .env ]; then
  say "加载 .env 配置"
  set -a; source .env; set +a
fi

MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"

# ---- 1. 检查 MySQL 是否运行 ----
if ! pgrep -x mysqld >/dev/null 2>&1; then
  say "启动 MySQL 服务..."
  if [ -x "${MYSQL_BIN}/mysqld" ]; then
    nohup "${MYSQL_BIN}/mysqld" \
      --basedir="${MYSQL_BIN}/.." \
      --datadir="${HOME}/mysql-data" \
      --port="${MYSQL_PORT}" \
      --socket=/tmp/mysql.sock \
      --pid-file="${HOME}/mysql-data/mysqld.pid" \
      --lower-case-table-names=2 \
      > "${HOME}/mysql-data/server.log" 2>&1 &
    for i in $(seq 1 20); do
      sleep 1
      lsof -i :"${MYSQL_PORT}" >/dev/null 2>&1 && break
    done
  else
    die "未找到 mysqld（${MYSQL_BIN}/mysqld）。请先安装 MySQL Community Server。"
  fi
fi
lsof -i :"${MYSQL_PORT}" >/dev/null 2>&1 && say "MySQL 已就绪 (${MYSQL_HOST}:${MYSQL_PORT})" || die "MySQL 启动失败，请查看 ${HOME}/mysql-data/server.log"

MYSQL="${MYSQL_BIN}/mysql"
export PATH="${MYSQL_BIN}:${PATH}"

# ---- 2. 校验数据库是否已初始化 ----
TABLE_COUNT=$("${MYSQL}" -h"${MYSQL_HOST}" -P"${MYSQL_PORT}" -u"${MYSQL_USER}" ${MYSQL_PASSWORD:+-p"${MYSQL_PASSWORD}"} \
  -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${MYSQL_DB}';" 2>/dev/null || echo 0)

if [ "${TABLE_COUNT}" -lt 10 ]; then
  warn "数据库 ${MYSQL_DB} 尚未初始化（仅 ${TABLE_COUNT} 张表）"
  say "正在初始化（等价于执行 mysql/setup.sh）..."
  MYSQL_PASSWORD="${MYSQL_PASSWORD}" bash mysql/setup.sh
fi
say "数据库已就绪（${TABLE_COUNT} 张表）"

# ---- 3. 启动平台 ----
if [ -z "${MYSQL_PASSWORD}" ]; then
  die "请设置 MYSQL_PASSWORD（可写入 .env 文件）"
fi

ENCODED_PASS=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${MYSQL_PASSWORD}")
DATABASE_URL="mysql2://${MYSQL_USER}:${ENCODED_PASS}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}"

say "启动平台（MySQL 后端，端口 ${APP_PORT}）..."
say "  首页:   http://127.0.0.1:${APP_PORT}/"
say "  后台:   http://127.0.0.1:${APP_PORT}/admin.html"
say "  数据库: MySQL ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}"
echo

DATABASE_URL="${DATABASE_URL}" BIND_ADDRESS=0.0.0.0 PORT="${APP_PORT}" exec ruby server.rb
