require "json"
require "minitest/autorun"
require "net/http"
require "tmpdir"
require "webrick"
require_relative "server"


# 数据库适配层测试辅助：模拟 PostgreSQL 连接，用于在无 PG 环境时验证 SQL 转换
class FakePGResult
  include Enumerable

  def initialize(rows)
    @rows = rows
  end

  def each(&block)
    @rows.each(&block)
  end
end

class FakePGConnection
  attr_reader :calls

  def initialize
    @calls = []
  end

  def type_map_for_results=(_value); end

  def exec_params(sql, binds)
    @calls << [sql, binds]
    raise "SQL 中仍残留 ? 占位符: #{sql}" if sql.include?("?")
    FakePGResult.new(sql.include?("information_schema") ? [{ "column_name" => "id" }] : [])
  end

  def exec(sql)
    @calls << [sql, []]
    FakePGResult.new([])
  end

  def transaction; end
  def commit; end
  def rollback; end

  def transaction_active?
    true
  end

  def transaction_status
    1
  end

  def close; end
end

class GramBackendTest < Minitest::Test
  ADMIN_PASSWORD = "test-only-admin-secret-2026"

  def setup
    @old_admin_username = ENV["GRAM_ADMIN_USERNAME"]
    @old_admin_password = ENV["GRAM_ADMIN_PASSWORD"]
    ENV["GRAM_ADMIN_USERNAME"] = "test_admin"
    ENV["GRAM_ADMIN_PASSWORD"] = ADMIN_PASSWORD
    @directory = Dir.mktmpdir("gram-backend-test")
    @service = GramService.new(File.join(@directory, "test.sqlite3"))
    @server = WEBrick::HTTPServer.new(
      Port: 0, BindAddress: "127.0.0.1", AccessLog: [],
      Logger: WEBrick::Log.new(File::NULL, WEBrick::Log::FATAL)
    )
    api = GramServer.new(@service)
    @server.mount("/api", GramApiServlet, api)
    @thread = Thread.new { @server.start }
    @thread.report_on_exception = false if @thread.respond_to?(:report_on_exception=)
    # 等待 WEBrick 真正进入 accept 循环，避免 shutdown 早于 start 触发关闭竞态
    # （该竞态会让服务线程永久阻塞在 IO.select，进而导致 teardown 的 join 挂起）
    deadline = Time.now + 5
    sleep 0.002 while @server.status != :Running && @thread.alive? && Time.now < deadline
    @port = @server.listeners.first.addr[1]
  end

  def teardown
    @server.shutdown
    @thread.join(5)
    @thread.kill if @thread.alive?
    @service.database.close
    FileUtils.remove_entry(@directory)
    restore_environment("GRAM_ADMIN_USERNAME", @old_admin_username)
    restore_environment("GRAM_ADMIN_PASSWORD", @old_admin_password)
  end

  def restore_environment(key, value)
    value.nil? ? ENV.delete(key) : ENV[key] = value
  end

  def call_api(method, path, body: nil, cookie: nil, csrf: nil)
    request_class = {
      "GET" => Net::HTTP::Get, "POST" => Net::HTTP::Post,
      "PATCH" => Net::HTTP::Patch, "PUT" => Net::HTTP::Put,
      "DELETE" => Net::HTTP::Delete
    }.fetch(method)
    request = request_class.new(path)
    request["Content-Type"] = "application/json" if body
    request["Cookie"] = cookie if cookie
    request["X-CSRF-Token"] = csrf if csrf
    request.body = JSON.generate(body) if body
    response = Net::HTTP.start("127.0.0.1", @port) { |http| http.request(request) }
    [response, response.body.empty? ? {} : JSON.parse(response.body)]
  end

  def sign_in(username, password)
    response, data = call_api("POST", "/api/login", body: { username: username, password: password })
    assert_equal "200", response.code
    [response.get_fields("set-cookie").first.split(";").first, data.fetch("csrfToken")]
  end

  def create_user
    admin = @service.first("SELECT * FROM users WHERE role = 'admin'")
    response, data = call_api(
      "POST", "/api/register",
      body: { username: "player_one", password: "player-password-123", invitationCode: admin["invitation_code"] }
    )
    assert_equal "200", response.code
    assert_match(/\A[A-Z0-9]{5}\z/, data.fetch("user").fetch("invitationCode"))
    assert_equal admin["id"], data.fetch("user").fetch("invitedBy")
    [response.get_fields("set-cookie").first.split(";").first, data.fetch("csrfToken")]
  end

  # 新注册账户初始余额为 0；测试通过服务端直接入账模拟已到账资金。
  def fund_user(username, units)
    @service.execute("UPDATE users SET balance_units = ? WHERE username = ?", units, username)
  end

  def test_registration_login_and_persistent_server_session
    cookie, csrf = create_user
    response, state = call_api("GET", "/api/state", cookie: cookie)
    assert_equal "200", response.code
    assert_equal "player_one", state.dig("user", "username")
    assert_equal 0, state.dig("user", "balanceUnits")
    assert_equal csrf, state.fetch("csrfToken")
    assert_equal 8, state.fetch("poolRules").length
    assert_equal "200", call_api("POST", "/api/logout", body: {}, cookie: cookie, csrf: csrf).first.code
    assert_equal "401", call_api("GET", "/api/state", cookie: cookie).first.code

    bad_response, = call_api("POST", "/api/login", body: { username: "player_one", password: "wrong-password" })
    assert_equal "401", bad_response.code
    signed_cookie, = sign_in("PLAYER_ONE", "player-password-123")
    assert_equal "200", call_api("GET", "/api/session", cookie: signed_cookie).first.code
  end

  def test_server_round_settlement_is_held_until_expiry_and_reveal_is_verifiable
    cookie, csrf = create_user
    fund_user("player_one", 100_000)
    @service.execute("UPDATE pool_configs SET duration_seconds = 1 WHERE level = 1")
    response, round = call_api(
      "POST", "/api/rounds",
      body: { level: 1, method: 1, amountUnits: 1_000 },
      cookie: cookie, csrf: csrf
    )
    assert_equal "200", response.code
    assert_nil round["won"]
    assert_nil round["fairnessSecret"]
    assert_equal 1_000, round["betAmount"]
    assert_match(/\A[0-9a-f]{64}\z/, round["fairnessCommitment"])

    sleep 1.1
    state_response, state = call_api("GET", "/api/state", cookie: cookie)
    assert_equal "200", state_response.code
    settled = state.fetch("rounds").first
    assert_equal true, settled["settled"]
    assert_equal OpenSSL::Digest::SHA256.hexdigest(settled["fairnessSecret"]), settled["fairnessCommitment"]
    assert_equal settled["won"], settled["fairnessDraw"] < settled["winProbabilityBp"]
    assert_equal 1, state.fetch("walletHistory").length
  end

  def test_server_rejects_client_balance_forgery_and_unauthorized_admin_access
    cookie, csrf = create_user
    missing_csrf, = call_api(
      "POST", "/api/wallet/deposit", body: { amountUnits: 100 }, cookie: cookie
    )
    invalid_csrf, = call_api(
      "POST", "/api/wallet/deposit", body: { amountUnits: 100 }, cookie: cookie, csrf: "invalid-token"
    )
    assert_equal "403", missing_csrf.code
    assert_equal "403", invalid_csrf.code

    response, = call_api(
      "POST", "/api/wallet/withdraw",
      body: { amountUnits: 999_999_999, address: "fake-address-123" },
      cookie: cookie, csrf: csrf
    )
    assert_equal "422", response.code
    assert_equal "403", call_api("GET", "/api/admin", cookie: cookie).first.code
  end

  def test_admin_updates_public_pool_odds_and_catalog_with_audit_trail
    cookie, csrf = sign_in("test_admin", ADMIN_PASSWORD)
    response, = call_api(
      "PATCH", "/api/admin/pools/1",
      body: {
        enabled: true, entryUnits: 10_000, minimumUnits: 1_000,
        durationSeconds: 75, winProbabilityBp: 3_000, profitPercent: 30
      },
      cookie: cookie, csrf: csrf
    )
    assert_equal "200", response.code

    gift_response, gift = call_api(
      "PUT", "/api/admin/gifts/stargift",
      body: { name: "星辰礼物", english: "Star Gifts", category: "other", active: true },
      cookie: cookie, csrf: csrf
    )
    assert_equal "200", gift_response.code
    assert_equal "stargift", gift["slug"]
    dashboard_response, dashboard = call_api("GET", "/api/admin", cookie: cookie)
    assert_equal "200", dashboard_response.code
    assert_equal 3_000, dashboard.fetch("poolRules").first.fetch("winProbabilityBp")
    assert dashboard.fetch("audit").fetch("items").length >= 2
  end

  def test_collection_records_are_server_owned_and_audited
    cookie, csrf = create_user
    add_response, result = call_api(
      "POST", "/api/holdings",
      body: { slug: "bondedring" }, cookie: cookie, csrf: csrf
    )
    assert_equal "200", add_response.code
    holding_id = result.fetch("holdingId")
    state_response, state = call_api("GET", "/api/state", cookie: cookie    )
    assert_equal "200", state_response.code
    assert_equal holding_id, state.fetch("holdings").first.fetch("id")
    assert @service.first("SELECT id FROM holdings WHERE id = ?", holding_id)

    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    remove_response, removal = call_api(
      "DELETE", "/api/admin/holdings/#{holding_id}",
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", remove_response.code, removal.inspect
    assert @service.admin_dashboard.fetch(:audit).fetch(:items).any? { |entry| entry[:action] == "holding_remove" }
  end

  def test_admin_dashboard_exposes_demo_wallet_ledger_and_auditable_risk_flags
    cookie, csrf = create_user
    fund_user("player_one", 100_000)
    deposit_response, = call_api(
      "POST", "/api/wallet/deposit",
      body: { amountUnits: 5_000 }, cookie: cookie, csrf: csrf
    )
    assert_equal "200", deposit_response.code
    @service.execute("UPDATE pool_configs SET duration_seconds = 1 WHERE level = 1")
    round_response, round = call_api(
      "POST", "/api/rounds",
      body: { level: 1, method: 1, amountUnits: 1_000 },
      cookie: cookie, csrf: csrf
    )
    assert_equal "200", round_response.code
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)

    flag_response, = call_api(
      "PATCH", "/api/admin/rounds/#{round.fetch("id")}/risk",
      body: { flagged: true, reason: "重复高频下注待复核" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", flag_response.code
    stored_result = @service.first("SELECT result FROM rounds WHERE id = ?", round.fetch("id"))["result"]
    dashboard_response, dashboard = call_api("GET", "/api/admin", cookie: admin_cookie)
    assert_equal "200", dashboard_response.code
    assert_equal 1, dashboard.dig("stats", "userCount")
    assert_equal 1, dashboard.dig("stats", "roundCount")
    assert dashboard.fetch("walletRequests").fetch("items").any? { |entry| entry["kind"] == "deposit" && entry["status"] == "pending" }
    flagged_round = dashboard.fetch("rounds").fetch("items").find { |entry| entry["id"] == round.fetch("id") }
    assert_equal true, flagged_round.fetch("riskFlag")
    assert_equal "重复高频下注待复核", flagged_round.fetch("riskNote")

    sleep 1.1
    _, state = call_api("GET", "/api/state", cookie: cookie)
    settled = state.fetch("rounds").first
    assert_equal stored_result == 1, settled.fetch("won")
    assert_equal OpenSSL::Digest::SHA256.hexdigest(settled.fetch("fairnessSecret")), settled.fetch("fairnessCommitment")
    assert @service.admin_dashboard.fetch(:audit).fetch(:items).any? { |entry| entry[:action] == "round_risk_flag" }

    suspend_response, = call_api(
      "PATCH", "/api/admin/users/#{state.dig("user", "id")}",
      body: { status: "suspended", reason: "多账户异常操作复核" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", suspend_response.code
    assert_equal "401", call_api("GET", "/api/state", cookie: cookie).first.code
  end

  def test_wallet_deposit_and_withdraw_require_admin_decision
    cookie, csrf = create_user
    fund_user("player_one", 100_000)
    initial_balance = @service.first("SELECT balance_units FROM users WHERE username = ?", "player_one")["balance_units"]

    deposit_response, deposit = call_api(
      "POST", "/api/wallet/deposit",
      body: { amountUnits: 5_000 }, cookie: cookie, csrf: csrf
    )
    assert_equal "200", deposit_response.code
    assert_equal initial_balance, deposit.dig("state", "user", "balanceUnits")
    assert_equal "pending", deposit.dig("state", "walletRequests").first.fetch("status")

    withdraw_response, withdraw = call_api(
      "POST", "/api/wallet/withdraw",
      body: { amountUnits: 10_000, address: "demo-address-123" }, cookie: cookie, csrf: csrf
    )
    assert_equal "200", withdraw_response.code
    assert_equal initial_balance - 10_000, withdraw.dig("state", "user", "balanceUnits")
    withdraw_id = withdraw.fetch("requestId")
    deposit_id = deposit.fetch("requestId")

    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    cancel_response, = call_api(
      "PATCH", "/api/admin/wallet-requests/#{withdraw_id}",
      body: { decision: "cancel", reason: "提现取消审核" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", cancel_response.code
    after_cancel = call_api("GET", "/api/state", cookie: cookie).last
    assert_equal initial_balance, after_cancel.dig("user", "balanceUnits")
    assert_equal "cancelled", after_cancel.fetch("walletRequests").find { |item| item["id"] == withdraw_id }.fetch("status")

    approve_response, = call_api(
      "PATCH", "/api/admin/wallet-requests/#{deposit_id}",
      body: { decision: "approve", reason: "充值审核通过" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", approve_response.code
    after_approval = call_api("GET", "/api/state", cookie: cookie).last
    assert_equal initial_balance + 5_000, after_approval.dig("user", "balanceUnits")
    assert_equal "approved", after_approval.fetch("walletRequests").find { |item| item["id"] == deposit_id }.fetch("status")
    assert @service.admin_dashboard.fetch(:walletEvents).fetch(:items).any? { |event| event[:kind] == "deposit" }

    duplicate_response, = call_api(
      "PATCH", "/api/admin/wallet-requests/#{deposit_id}",
      body: { decision: "cancel", reason: "重复审核测试" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "409", duplicate_response.code
  end

  def create_agent(admin_cookie, admin_csrf, username = "agent_one")
    response, data = call_api(
      "POST", "/api/admin/agents",
      body: { username: username, password: "agent-password-123" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", response.code
    [data.fetch("user").fetch("id"), data.fetch("user").fetch("invitationCode")]
  end

  def test_registration_requires_a_valid_invitation_code
    admin = @service.first("SELECT * FROM users WHERE role = 'admin'")
    admin_code = admin.fetch("invitation_code")
    assert_match(/\A[A-Z0-9]{5}\z/, admin_code)

    missing, = call_api("POST", "/api/register", body: { username: "no_code_user", password: "password-123456" })
    assert_equal "422", missing.code

    invalid, = call_api("POST", "/api/register", body: { username: "no_code_user", password: "password-123456", invitationCode: "ZZZZZ" })
    assert_equal "422", invalid.code

    response, registered = call_api(
      "POST", "/api/register",
      body: { username: "invited_user", password: "password-123456", invitationCode: admin_code.downcase }
    )
    assert_equal "200", response.code
    user = registered.fetch("user")
    assert_match(/\A[A-Z0-9]{5}\z/, user.fetch("invitationCode"))
    assert_equal admin.fetch("id"), user.fetch("invitedBy")
    refute_equal admin_code, user.fetch("invitationCode")

    duplicate, duplicate_user = call_api(
      "POST", "/api/register",
      body: { username: "invited_user", password: "password-123456", invitationCode: admin_code }
    )
    assert_equal "409", duplicate.code
  end

  def test_admin_creates_agent_and_users_register_under_it
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    agent_id, agent_code = create_agent(admin_cookie, admin_csrf)
    assert_match(/\A[A-Z0-9]{5}\z/, agent_code)
    assert @service.first("SELECT role FROM users WHERE id = ?", agent_id)["role"] == "agent"

    response, registered = call_api(
      "POST", "/api/register",
      body: { username: "agent_downline", password: "password-123456", invitationCode: agent_code }
    )
    assert_equal "200", response.code
    assert_equal agent_id, registered.fetch("user").fetch("invitedBy")

    create_response, created = call_api(
      "POST", "/api/admin/users",
      body: { username: "admin_made", password: "password-123456", displayName: "主后台生成", invitedBy: agent_id },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", create_response.code
    assert_match(/\A[A-Z0-9]{5}\z/, created.fetch("user").fetch("invitationCode"))
    assert_equal agent_id, created.fetch("user").fetch("invitedBy")

    renew_response, renewed = call_api(
      "PATCH", "/api/admin/users/#{agent_id}/invitation",
      body: {}, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", renew_response.code
    new_code = renewed.fetch("invitationCode")
    assert_match(/\A[A-Z0-9]{5}\z/, new_code)
    refute_equal agent_code, new_code
    assert_equal "422", call_api(
      "POST", "/api/register",
      body: { username: "late_user", password: "password-123456", invitationCode: agent_code }
    ).first.code

    agent_cookie, agent_csrf = sign_in("agent_one", "agent-password-123")
    agent_dashboard = call_api("GET", "/api/agent", cookie: agent_cookie).last
    assert_equal "agent", agent_dashboard.fetch("viewer").fetch("role")
    assert_equal 2, agent_dashboard.fetch("stats").fetch("userCount")
    usernames = agent_dashboard.fetch("users").fetch("items").map { |user| user.fetch("username") }
    assert_includes usernames, "agent_downline"
    assert_includes usernames, "admin_made"
    refute_includes usernames, "test_admin"
    assert agent_dashboard.fetch("audit").fetch("items").empty?

    forbidden, = call_api("GET", "/api/admin", cookie: agent_cookie)
    assert_equal "403", forbidden.code
    forbidden_create, = call_api(
      "POST", "/api/admin/users",
      body: { username: "agent_made", password: "password-123456" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "403", forbidden_create.code
  end

  def test_agent_scope_is_limited_to_their_own_downline
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    agent_id, agent_code = create_agent(admin_cookie, admin_csrf, "agent_scope")

    other_agent_id, other_code = create_agent(admin_cookie, admin_csrf, "agent_other")
    call_api(
      "POST", "/api/register",
      body: { username: "other_downline", password: "password-123456", invitationCode: other_code }
    )
    _, created = call_api(
      "POST", "/api/admin/users",
      body: { username: "scoped_user", password: "password-123456", invitedBy: agent_id },
      cookie: admin_cookie, csrf: admin_csrf
    )
    scoped_id = created.fetch("user").fetch("id")

    agent_cookie, agent_csrf = sign_in("agent_scope", "agent-password-123")
    dashboard = call_api("GET", "/api/agent", cookie: agent_cookie).last
    assert_equal 1, dashboard.fetch("stats").fetch("userCount")
    assert_equal [scoped_id], dashboard.fetch("users").fetch("items").map { |user| user.fetch("id") }

    allowed, = call_api(
      "PATCH", "/api/admin/users/#{scoped_id}",
      body: { status: "suspended", reason: "代理复核名下用户" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "200", allowed.code

    foreign_user_id = @service.first("SELECT id FROM users WHERE username = 'other_downline'")["id"]
    blocked, = call_api(
      "PATCH", "/api/admin/users/#{foreign_user_id}",
      body: { status: "suspended", reason: "越权停用他人名下用户" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "403", blocked.code
    assert_equal "active", @service.first("SELECT status FROM users WHERE id = ?", foreign_user_id)["status"]

    foreign_admin_blocked, = call_api(
      "PATCH", "/api/admin/users/#{other_agent_id}",
      body: { status: "suspended", reason: "越权停用代理" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "403", foreign_admin_blocked.code
  end

  def test_agent_can_review_downline_wallet_requests_only
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    agent_id, agent_code = create_agent(admin_cookie, admin_csrf, "agent_wallet")
    call_api(
      "POST", "/api/admin/users",
      body: { username: "agent_wallet_user", password: "password-123456", invitedBy: agent_id },
      cookie: admin_cookie, csrf: admin_csrf
    )
    call_api(
      "POST", "/api/register",
      body: {
        username: "stranger_user", password: "password-123456",
        invitationCode: @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
      }
    )

    agent_cookie, agent_csrf = sign_in("agent_wallet", "agent-password-123")
    downline_cookie, downline_csrf = sign_in("agent_wallet_user", "password-123456")
    _, deposit = call_api(
      "POST", "/api/wallet/deposit",
      body: { amountUnits: 5_000 }, cookie: downline_cookie, csrf: downline_csrf
    )
    request_id = deposit.fetch("requestId")

    allowed, = call_api(
      "PATCH", "/api/admin/wallet-requests/#{request_id}",
      body: { decision: "approve", reason: "代理审核名下充值" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "200", allowed.code

    stranger_cookie, stranger_csrf = sign_in("stranger_user", "password-123456")
    _, stranger_deposit = call_api(
      "POST", "/api/wallet/deposit",
      body: { amountUnits: 5_000 }, cookie: stranger_cookie, csrf: stranger_csrf
    )
    blocked, = call_api(
      "PATCH", "/api/admin/wallet-requests/#{stranger_deposit.fetch("requestId")}",
      body: { decision: "approve", reason: "越权审核他人充值" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "403", blocked.code
  end

  def test_admin_lists_are_paginated_by_ten
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    code = @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
    12.times { |index| @service.register("page_user_#{index}", "password-123456", code) }

    first_page, page_one = call_api("GET", "/api/admin/list?resource=users&page=1", cookie: admin_cookie)
    assert_equal "200", first_page.code
    assert_equal 10, page_one.fetch("items").length
    assert_equal 10, page_one.fetch("perPage")
    assert_equal 13, page_one.fetch("total")
    assert_equal 2, page_one.fetch("totalPages")
    assert_equal 1, page_one.fetch("page")

    _, page_two = call_api("GET", "/api/admin/list?resource=users&page=2", cookie: admin_cookie)
    assert_equal 3, page_two.fetch("items").length
    assert_equal 2, page_two.fetch("page")
    refute_equal page_one.fetch("items").map { |item| item.fetch("id") },
                 page_two.fetch("items").map { |item| item.fetch("id") }

    _, overflow = call_api("GET", "/api/admin/list?resource=users&page=99", cookie: admin_cookie)
    assert_equal 2, overflow.fetch("page")
    _, zero_page = call_api("GET", "/api/admin/list?resource=users&page=0", cookie: admin_cookie)
    assert_equal 1, zero_page.fetch("page")

    _, filtered = call_api("GET", "/api/admin/list?resource=users&page=1&q=page_user_5", cookie: admin_cookie)
    assert_equal 1, filtered.fetch("total")
    assert_equal "page_user_5", filtered.fetch("items").first.fetch("username")

    unknown, = call_api("GET", "/api/admin/list?resource=nope&page=1", cookie: admin_cookie)
    assert_equal "404", unknown.code
  end

  def test_admin_can_force_win_lose_and_reset_round_outcome
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    code = @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
    @service.register("forced_user", "password-123456", code)
    user_id = @service.first("SELECT id FROM users WHERE username = 'forced_user'").fetch("id")
    @service.execute("UPDATE users SET balance_units = 100_000 WHERE id = ?", user_id)
    @service.execute("UPDATE pool_configs SET duration_seconds = 1 WHERE level = 1")

    @service.create_round(@service.first("SELECT * FROM users WHERE id = ?", user_id), { "level" => 1, "method" => 1, "amountUnits" => 1_000 })
    round_id = @service.first("SELECT id FROM rounds WHERE user_id = ?", user_id).fetch("id")
    @service.execute("UPDATE rounds SET ends_at = ? WHERE id = ?", Time.now.to_i - 1, round_id)

    win_response, = call_api(
      "PATCH", "/api/admin/rounds/#{round_id}/outcome",
      body: { outcome: "win" }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", win_response.code
    forced = @service.first("SELECT * FROM rounds WHERE id = ?", round_id)
    assert_equal 1, forced.fetch("result")
    assert_equal "win", forced.fetch("forced_outcome")

    @service.settle_due_rounds(user_id)
    balance = @service.first("SELECT balance_units FROM users WHERE id = ?", user_id).fetch("balance_units")
    assert_equal 100_000 + 300, balance

    lose_response, = call_api(
      "PATCH", "/api/admin/rounds/#{round_id}/outcome",
      body: { outcome: "lose" }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "409", lose_response.code

    invalid, = call_api(
      "PATCH", "/api/admin/rounds/#{round_id}/outcome",
      body: { outcome: "sideways" }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "422", invalid.code

    @service.create_round(@service.first("SELECT * FROM users WHERE id = ?", user_id), { "level" => 1, "method" => 1, "amountUnits" => 1_000 })
    second_id = @service.first("SELECT id FROM rounds WHERE user_id = ? AND settled_at IS NULL", user_id).fetch("id")
    @service.execute("UPDATE users SET balance_units = 100_000 WHERE id = ?", user_id)
    reset_response, = call_api(
      "PATCH", "/api/admin/rounds/#{second_id}/outcome",
      body: { outcome: "reset" }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", reset_response.code
    restored = @service.first("SELECT * FROM rounds WHERE id = ?", second_id)
    natural = restored.fetch("fairness_draw") < restored.fetch("win_probability_bp") ? 1 : 0
    assert_equal natural, restored.fetch("result")
    assert_nil restored.fetch("forced_outcome")

    audit = @service.admin_dashboard.fetch(:audit).fetch(:items)
    assert audit.any? { |entry| entry[:action] == "round_force_win" }
    assert audit.any? { |entry| entry[:action] == "round_force_reset" }

    _, rounds_page = call_api("GET", "/api/admin/list?resource=rounds&page=1", cookie: admin_cookie)
    assert_equal 10, rounds_page.fetch("perPage")
    assert_includes rounds_page.fetch("items").map { |item| item.key?("forcedOutcome") }, true
  end

  def test_agent_list_endpoint_is_scoped_and_blocks_audit
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    agent_id, agent_code = create_agent(admin_cookie, admin_csrf, "agent_pager")
    call_api(
      "POST", "/api/admin/users",
      body: { username: "paged_user", password: "password-123456", invitedBy: agent_id },
      cookie: admin_cookie, csrf: admin_csrf
    )
    call_api("POST", "/api/register", body: { username: "outer_user", password: "password-123456", invitationCode: admin_code_of(admin_cookie) })
    @service.execute("UPDATE users SET balance_units = 100_000 WHERE username = 'paged_user'")
    @service.create_round(@service.first("SELECT * FROM users WHERE username = 'paged_user'"), { "level" => 1, "method" => 1, "amountUnits" => 1_000 })

    agent_cookie, agent_csrf = sign_in("agent_pager", "agent-password-123")
    _, users_page = call_api("GET", "/api/admin/list?resource=users&page=1", cookie: agent_cookie)
    usernames = users_page.fetch("items").map { |item| item.fetch("username") }
    assert_includes usernames, "paged_user"
    refute_includes usernames, "outer_user"

    _, rounds_page = call_api("GET", "/api/admin/list?resource=rounds&page=1", cookie: agent_cookie)
    assert_equal 1, rounds_page.fetch("items").length
    assert_equal "paged_user", rounds_page.fetch("items").first.fetch("username")

    blocked, = call_api("GET", "/api/admin/list?resource=audit&page=1", cookie: agent_cookie)
    assert_equal "403", blocked.code
    blocked_agents, = call_api("GET", "/api/admin/list?resource=agents&page=1", cookie: agent_cookie)
    assert_equal "403", blocked_agents.code

    outsider_cookie, outsider_csrf = sign_in("outer_user", "password-123456")
    forbidden, = call_api("GET", "/api/admin/list?resource=users&page=1", cookie: outsider_cookie)
    assert_equal "403", forbidden.code
  end

  def admin_code_of(cookie)
    @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
  end

  def test_admin_manages_deposit_addresses_and_users_see_active_ones
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    code = @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
    @service.register("addr_user", "password-123456", code)
    user_cookie, user_csrf = sign_in("addr_user", "password-123456")

    _, initial = call_api("GET", "/api/deposit-addresses", cookie: user_cookie)
    assert_equal [], initial.fetch("addresses")

    create_response, created = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "USDT-TRC20", address: "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1", note: "最低 10 GRAM" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", create_response.code
    address_id = created.fetch("address").fetch("id")
    assert_equal "USDT-TRC20", created.fetch("address").fetch("label")

    _, listed = call_api("GET", "/api/deposit-addresses", cookie: user_cookie)
    assert_equal 1, listed.fetch("addresses").length
    assert_equal "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1", listed.fetch("addresses").first.fetch("address")

    update_response, updated = call_api(
      "PATCH", "/api/admin/deposit-addresses/#{address_id}",
      body: { label: "USDT-TRC20 主地址", address: "TNewAddr0000000000000000000000000001", note: "已更新" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", update_response.code
    assert_equal "TNewAddr0000000000000000000000000001", updated.fetch("address").fetch("address")

    _, after_update = call_api("GET", "/api/deposit-addresses", cookie: user_cookie)
    assert_equal "TNewAddr0000000000000000000000000001", after_update.fetch("addresses").first.fetch("address")

    deactivate, = call_api(
      "PATCH", "/api/admin/deposit-addresses/#{address_id}/status",
      body: { active: false }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", deactivate.code
    _, hidden = call_api("GET", "/api/deposit-addresses", cookie: user_cookie)
    assert_equal [], hidden.fetch("addresses")

    _, admin_list = call_api("GET", "/api/admin/deposit-addresses", cookie: admin_cookie)
    assert_equal 1, admin_list.fetch("addresses").length
    assert_equal false, admin_list.fetch("addresses").first.fetch("active")

    delete_response, = call_api(
      "DELETE", "/api/admin/deposit-addresses/#{address_id}",
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "200", delete_response.code
    _, empty_again = call_api("GET", "/api/admin/deposit-addresses", cookie: admin_cookie)
    assert_equal [], empty_again.fetch("addresses")
  end

  def test_deposit_address_validation_and_permissions
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)

    bad_name, = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "", address: "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "422", bad_name.code

    bad_address, = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "短地址", address: "abc" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "422", bad_address.code

    spaced, = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "带空格", address: "TQn9 Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "422", spaced.code

    create_agent(admin_cookie, admin_csrf, "agent_addr_guard")
    agent_cookie, agent_csrf = sign_in("agent_addr_guard", "agent-password-123")
    forbidden, = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "越权", address: "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1" },
      cookie: agent_cookie, csrf: agent_csrf
    )
    assert_equal "403", forbidden.code
    forbidden_list, = call_api("GET", "/api/admin/deposit-addresses", cookie: agent_cookie)
    assert_equal "403", forbidden_list.code

    missing, = call_api(
      "PATCH", "/api/admin/deposit-addresses/99999",
      body: { label: "不存在" }, cookie: admin_cookie, csrf: admin_csrf
    )
    assert_equal "404", missing.code
  end

  def test_deposit_request_requires_and_records_address
    admin_cookie, admin_csrf = sign_in("test_admin", ADMIN_PASSWORD)
    code = @service.first("SELECT invitation_code FROM users WHERE role = 'admin'").fetch("invitation_code")
    @service.register("depo_user", "password-123456", code)
    user_cookie, user_csrf = sign_in("depo_user", "password-123456")

    _, created = call_api(
      "POST", "/api/admin/deposit-addresses",
      body: { label: "USDT-TRC20", address: "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1" },
      cookie: admin_cookie, csrf: admin_csrf
    )
    address_id = created.fetch("address").fetch("id")

    deposit_response, deposit = call_api(
      "POST", "/api/wallet/deposit",
      body: { amountUnits: 5_000, address: "USDT-TRC20｜TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1" },
      cookie: user_cookie, csrf: user_csrf
    )
    assert_equal "200", deposit_response.code
    request_id = deposit.fetch("requestId")
    stored = @service.first("SELECT * FROM wallet_requests WHERE id = ?", request_id)
    assert_includes stored.fetch("address"), "TQn9Y2khEsC7ZP5xV4uLmW3bN8dF6gHjK1"

    _, dashboard = call_api("GET", "/api/admin", cookie: admin_cookie)
    entry = dashboard.fetch("walletRequests").fetch("items").find { |item| item.fetch("id") == request_id }
    refute_nil entry
    assert_includes entry.fetch("address"), "USDT-TRC20"
  end
  def build_fake_postgres_adapter
    adapter = GRAMDB::Postgres.allocate
    adapter.instance_variable_set(:@kind, :postgres)
    adapter.instance_variable_set(:@raw, FakePGConnection.new)
    adapter
  end

  def test_postgres_adapter_translates_placeholders_to_dollar_params
    adapter = build_fake_postgres_adapter
    fake = adapter.instance_variable_get(:@raw)

    adapter.execute("SELECT id, username FROM users WHERE id = ? AND role = ?", 5, "agent")
    sql, binds = fake.calls.last
    assert_equal "SELECT id, username FROM users WHERE id = $1 AND role = $2", sql
    assert_equal [5, "agent"], binds
    refute_includes sql, "?"
    assert_equal "SELECT * FROM users WHERE id = $1",
                 GRAMDB.translate_placeholders("SELECT * FROM users WHERE id = ?")
  end

  def test_postgres_adapter_normalizes_boolean_binds
    adapter = build_fake_postgres_adapter
    fake = adapter.instance_variable_get(:@raw)

    adapter.execute("UPDATE pool_configs SET enabled = ? WHERE level = ?", true, 1)
    assert_equal [1, 1], fake.calls.last[1]
    adapter.execute("UPDATE pool_configs SET enabled = ? WHERE level = ?", false, 1)
    assert_equal [0, 1], fake.calls.last[1]
  end

  def test_postgres_adapter_execute_batch_splits_statements
    adapter = build_fake_postgres_adapter
    fake = adapter.instance_variable_get(:@raw)

    before = fake.calls.length
    adapter.execute_batch("PRAGMA x; CREATE TABLE t (a int);\n\n CREATE TABLE u (b int);")
    assert_equal 3, fake.calls.length - before
  end

  def test_postgres_adapter_reads_columns_from_information_schema
    adapter = build_fake_postgres_adapter
    fake = adapter.instance_variable_get(:@raw)

    assert_equal %w[id], adapter.column_names("deposit_addresses")
    assert_includes fake.calls.last[0], "information_schema.columns"
  end

  def test_postgres_schema_avoids_sqlite_only_syntax
    source = File.read(File.join(__dir__, "server.rb"))
    schema = source[/def postgres_schema.*?(?=\n  def )/m]
    refute_nil schema
    assert_includes schema, "id BIGSERIAL PRIMARY KEY"
    refute_includes schema, "AUTOINCREMENT"
    refute_includes schema, "PRAGMA"
    refute_includes schema, "sqlite_master"
    %w[users sessions pool_configs gifts rounds wallet_events wallet_requests holdings admin_audit deposit_addresses].each do |table|
      assert_includes schema, "CREATE TABLE IF NOT EXISTS #{table}"
    end
  end

  def test_database_url_selects_backend
    original_url = ENV["DATABASE_URL"]
    original_db = ENV["GRAM_DATABASE"]
    path = File.join(@directory, "selector.sqlite3")
    ENV["GRAM_DATABASE"] = path
    ENV.delete("DATABASE_URL")
    adapter = GRAMDB.build
    assert adapter.sqlite?
    refute adapter.postgres?
    adapter.close

    ENV["DATABASE_URL"] = "sqlite:#{path}"
    assert GRAMDB.build.sqlite?
    GRAMDB.build.close

    ENV["DATABASE_URL"] = "postgres://user:pass@127.0.0.1:5432/gram"
    assert_raises(LoadError) { GRAMDB.build }
  ensure
    original_url.nil? ? ENV.delete("DATABASE_URL") : ENV["DATABASE_URL"] = original_url
    original_db.nil? ? ENV.delete("GRAM_DATABASE") : ENV["GRAM_DATABASE"] = original_db
  end
end
