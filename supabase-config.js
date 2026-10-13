/* 前端后端寻址配置（自动识别）
 *
 * 本地运行（localhost / 127.0.0.1）→ 使用同源 /api，由本地 Ruby 后端
 *   处理，启动方式：ruby server.rb  或  ./start-mysql.sh
 * 公网访问（GitHub Pages 等）→ 使用 Supabase Edge Functions。
 *
 * 如需强制指定，可取消下面 AUTO_DETECT 的注释自行赋值。
 */
(function () {
  var SUPABASE_FN = "https://gyjqoxbpjlrvemoybktq.supabase.co/functions/v1/api";

  // true = 自动识别（推荐）；false = 手动指定，改下面这行即可
  var AUTO_DETECT = true;

  if (!AUTO_DETECT) {
    window.GRAM_API_BASE = "";   // 留空走本地；填 SUPABASE_FN 走 Supabase
    return;
  }

  var host = window.location.hostname;
  var isLocal = host === "localhost" ||
                host === "127.0.0.1" ||
                host === "[::1]" ||
                host === "0.0.0.0" ||
                /^192\.168\./.test(host) ||
                /^10\./.test(host) ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  // 本地（含局域网）走同源后端；公网走 Supabase
  window.GRAM_API_BASE = isLocal ? "" : SUPABASE_FN;
})();
