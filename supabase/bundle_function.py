#!/usr/bin/env python3
"""把 supabase/functions 打包成单文件，供 Supabase 管理 API 部署。

用法：python3 supabase/bundle_function.py > /tmp/bundled.ts

为什么需要打包：
    Management API 的 POST /v1/projects/{ref}/functions 只接受单文件 body，
    而 /functions/deploy 多文件上传在当前 API 上始终返回
   "Entrypoint path does not exist"，所以这里把 _shared 模块内联进 index.ts。

⚠️ 关键坑：该接口会恒定剥掉 body 的前 4 个字符。
   因此输出文件必须以前缀 `/**/`（4 字符空块注释）开头——
   被剥掉的正好是它，真实代码完整保留；即使不剥也是合法 JS。
   若首行是 // 注释，剥完后首行变成非法语法，函数启动即崩溃，
   浏览器只会看到 "Failed to fetch"。
"""
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(BASE, "supabase", "functions")
ENTRY = os.path.join(FUNCTIONS_DIR, "api", "index.ts")

# 4 字符冗余前缀，抵消接口的固定剥离
PADDING = "/**/\n"


def resolve_import(from_file, spec):
    if not spec.startswith("."):
        return None
    path = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    if not path.endswith(".ts"):
        path += ".ts"
    return path


def bundle(entry, seen=None):
    """内联相对路径 import；外部依赖（https://、node:）原样保留。"""
    seen = seen if seen is not None else set()
    if entry in seen:
        return ""
    seen.add(entry)

    code = open(entry, encoding="utf-8").read()

    named_import = re.compile(
        r'import\s+(?:type\s+)?\{[^}]*\}\s*from\s*"([^"]+)"\s*;?', re.S)
    side_effect = re.compile(r'import\s*"([^"]+)"\s*;?')

    def expand(match):
        target = resolve_import(entry, match.group(1))
        if target and os.path.exists(target):
            rel = os.path.relpath(target, FUNCTIONS_DIR)
            return ("\n// ===== inlined from %s =====\n" % rel
                    + bundle(target, seen)
                    + "\n// ===== end %s =====\n" % rel)
        return match.group(0)

    code = named_import.sub(expand, code)
    code = side_effect.sub(expand, code)
    return code


def main():
    bundled = bundle(ENTRY)
    # 只内联，不剥 TypeScript 类型：Deno 原生支持 TS
    output = PADDING + bundled

    leftover = re.findall(r'from\s+"\.\.?/', output)
    if leftover:
        sys.stderr.write("警告：仍有 %d 处本地 import 未内联\n" % len(leftover))

    if not re.search(r"Deno\.serve", output):
        sys.stderr.write("错误：打包结果缺少 Deno.serve 入口\n")
        sys.exit(1)

    sys.stdout.write(output)

    sys.stderr.write("打包完成：%d 字符，本地 import 残留 %d 处\n"
                     % (len(output), len(leftover)))


if __name__ == "__main__":
    main()
