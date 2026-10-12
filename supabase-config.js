/* 前端后端寻址配置
 *
 * 这一份文件决定前端把 /api 请求发到哪里：
 *
 * 1. 本地运行 / 自托管后端（默认）
 *    保持 GRAM_API_BASE 为空字符串，前端会请求同源的 /api，
 *    由 ruby server.rb 或任意反向代理处理。
 *
 * 2. 部署到 Supabase
 *    把冒号后面的内容替换成你的 Supabase 项目地址，形如：
 *      window.GRAM_API_BASE = "https://abcdefghijklmn.supabase.co/functions/v1/api";
 *    地址可在 Supabase 控制台 Project Settings → API → Project URL 找到，
 *    再拼上 /functions/v1/api（即部署后的 api 这个 Edge Function）。
 *
 *    前端静态页面仍需另行托管（GitHub Pages / Cloudflare Pages 等免费方案），
 *    它们只负责加载这些静态文件；所有 /api 请求会跨域发送到 Supabase，
 *    Edge Function 已开启 CORS，可直接访问。
 */
window.GRAM_API_BASE = "";
