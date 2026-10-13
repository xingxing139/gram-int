#!/usr/bin/env bash
# =====================================================================
# Supabase 一键部署（在你自己的电脑上运行）
#
# 为什么要在本机跑：沙箱/远程环境常常访问不到 <项目>.supabase.co，
# 只有本机能直连，出错了也能立刻在 Supabase Logs 里看到真实原因。
#
# 用法：
#   SUPABASE_PAT=sbp_你的令牌 ./supabase/deploy.sh gyjqoxbpjlrvemoybktq
#
# 令牌获取：https://supabase.com/dashboard/account/tokens
# =====================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { printf "${GREEN}▶${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

PROJECT_REF="${1:-gyjqoxbpjlrvemoybktq}"
PAT="${SUPABASE_PAT:-}"
[ -n "$PAT" ] || die "请设置环境变量 SUPABASE_PAT（在 Supabase 后台 Account → Tokens 生成）"
command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v python3 >/dev/null 2>&1 || die "需要 python3（用于构造上传请求）"

API="https://api.supabase.com/v1/projects/${PROJECT_REF}"
FN_URL="https://${PROJECT_REF}.supabase.co/functions/v1/api"

say "项目: ${PROJECT_REF}"
say "函数地址: ${FN_URL}"

# ---- 1. 打包为单文件 ----
say "打包 Edge Function ..."
python3 supabase/bundle_function.py > /tmp/gram_fn_bundle.ts 2>/tmp/gram_fn_bundle.log || {
  cat /tmp/gram_fn_bundle.log >&2
  die "打包失败"
}
cat /tmp/gram_fn_bundle.log >&2 || true
SIZE=$(wc -c < /tmp/gram_fn_bundle.ts | tr -d ' ')
say "打包完成：${SIZE} 字节"

# ---- 2. 通过管理 API 部署 ----
say "部署到 Supabase ..."
python3 - "$PAT" "$PROJECT_REF" /tmp/gram_fn_bundle.ts <<'PY' || die "部署失败，请看上面的输出"
import base64, json, subprocess, sys, urllib.request

pat, project, bundle = sys.argv[1], sys.argv[2], sys.argv[3]
code = open(bundle, encoding="utf-8").read()
payload = json.dumps({"slug": "api", "name": "api",
                      "verify_jwt": False, "body": code}).encode("utf-8")
api = "https://api.supabase.com/v1/projects/" + project

req = urllib.request.Request(api + "/functions/api", data=b"{}", method="DELETE",
                             headers={"Authorization": "Bearer " + pat})
try:
    urllib.request.urlopen(req, timeout=60).read()
except Exception:
    pass

req = urllib.request.Request(api + "/functions", data=payload, method="POST",
                             headers={"Authorization": "Bearer " + pat,
                                      "Content-Type": "application/json"})
try:
    body = urllib.request.urlopen(req, timeout=600).read().decode()
    info = json.loads(body)
    print("  已创建:", info.get("slug"), "status=", info.get("status"), "version=", info.get("version"))
except urllib.error.HTTPError as error:
    print("  部署失败 HTTP", error.code, error.read().decode()[:300])
    sys.exit(1)
PY

# ---- 3. 立刻本机验证（能直连，结果可信） ----
say "验证 /api/health ..."
for i in 1 2 3 4 5; do
  RESP=$(curl -sS --max-time 30 -w "\n%{http_code}" "${FN_URL}/api/health" 2>&1 || true)
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | head -1)
  printf "  第 %d 次: HTTP %s  %s\n" "$i" "$CODE" "$(echo "$BODY" | head -c 200)"
  echo "$BODY" | grep -q '"status"' && { say "部署成功 ✓"; exit 0; }
  sleep 3
done

die "函数仍未就绪。请打开 Supabase 控制台 → Edge Functions → api → Logs 查看 BOOT_ERROR 的具体原因，把日志发我。"