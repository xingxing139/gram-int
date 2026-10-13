/* 前端后端寻址配置
 *
 * 当前已指向 Supabase（PostgreSQL + Edge Functions）。
 * 项目：gram-int   ID: gyjqoxbpjlrvemoybktq  区域 ap-southeast-2
 *
 * 改回本地 Ruby 后端：把下面改成空字符串 window.GRAM_API_BASE = "";
 * 然后运行 ./start-mysql.sh 或 ruby server.rb。
 */
window.GRAM_API_BASE = "https://gyjqoxbpjlrvemoybktq.supabase.co/functions/v1/api";
