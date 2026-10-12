#!/usr/bin/env bash
# Supabase 一键部署脚本
#
# 前提：已安装 Supabase CLI（npm i -g supabase）并完成 supabase login
# 用法：./supabase/deploy.sh <项目ID> [函数名]
#
#   项目ID   Supabase 控制台 → Project Settings → General → Reference ID
#   函数名   默认 api
set -euo pipefail

PROJECT_REF="${1:-}"
FUNCTION_NAME="${2:-api}"
GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'

say() { printf "${GREEN}▶${NC} %s\n" "$1"; }
die() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

[ -n "${PROJECT_REF}" ] || die "请提供项目 ID，例如：./supabase/deploy.sh abcdefghijklmnop"

command -v supabase >/dev/null 2>&1 || die "未找到 supabase CLI，请先执行：npm i -g supabase"

say "关联项目 ${PROJECT_REF} ..."
supabase link --project-ref "${PROJECT_REF}"

say "推送数据库迁移（建表 + 种子数据 + 原子函数）..."
supabase db push

say "部署 Edge Function：${FUNCTION_NAME} ..."
supabase functions deploy "${FUNCTION_NAME}"

# 同步项目地址到前端配置
PROJECT_URL="https://${PROJECT_REF}.supabase.co"
say "写入前端 API 地址：${PROJECT_URL}/functions/v1/${FUNCTION_NAME}"
cat > ../supabase-config.js <<EOF
/* 前端后端寻址配置（由 supabase/deploy.sh 自动生成） */
window.GRAM_API_BASE = "${PROJECT_URL}/functions/v1/${FUNCTION_NAME}";
EOF

cat <<TEXT

$(printf "${GREEN}▶${NC} 后端部署完成。剩余两步：")

1) 在 Supabase 控制台为 Edge Function 配置服务端密钥（Project Settings → API）：
     SUPABASE_URL                 = ${PROJECT_URL}
     SUPABASE_SERVICE_ROLE_KEY    = service_role key（不是 anon key）
   Edge Function 只用 service_role 访问数据库，该密钥不会下发到浏览器。

2) 创建管理员账户并推送前端：
     ./supabase/seed-admin.sh <管理员用户名> <至少12位密码>
     git add supabase-config.js index.html admin.html && git commit -m "Point frontend at Supabase" && git push

   前端静态页面托管到 GitHub Pages / Cloudflare Pages（均免费）后即可访问。
TEXT
