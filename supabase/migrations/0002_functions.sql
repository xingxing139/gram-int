-- =====================================================================
-- GRAM 平台 · 原子操作函数（RPC）
--
-- 原 Ruby 版用 BEGIN/COMMIT 事务包裹「校验余额 → 扣款 → 写记录」。
-- 迁移到 PostgREST 后无法包裹多语句事务，因此把这些复合操作下沉为
-- Postgres 函数，单次调用即原子执行；关键行通过 FOR UPDATE 锁定，
-- 避免并发下注导致超额扣款。
--
-- 全部函数都以 SECURITY DEFINER 运行（定义者权限），仅允许 service_role 调用。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 铸造下注：校验门槛与余额，扣减本金，并按给定的开奖结果写入轮次
--   p_id           轮次 UUID
--   p_user_id      用户
--   p_level        铸造池等级
--   p_stake_units  下注金额（单位）
--   p_result       开奖结果：1 = 赢，0 = 输（由服务端随机承诺值决定）
--   返回            { stake_units, profit_units, win_probability_bp, profit_percent }
-- ---------------------------------------------------------------------
create or replace function public.place_round(
  p_id text,
  p_user_id bigint,
  p_level integer,
  p_stake_units integer,
  p_method integer,
  p_result integer,
  p_fairness_secret text,
  p_fairness_commitment text,
  p_fairness_nonce integer,
  p_fairness_draw integer,
  p_win_probability_bp integer,
  p_profit_percent integer
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_config        pool_configs%rowtype;
  v_user          users%rowtype;
  v_reserved      integer;
  v_total_balance integer;
  v_profit        integer;
  v_started_at    bigint;
begin
  -- 串行化同一用户的并发下注
  select * into v_user from users where id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  select * into v_config from pool_configs where level = p_level;
  if not found or v_config.enabled <> 1 then
    raise exception 'POOL_UNAVAILABLE';
  end if;

  if p_stake_units < v_config.minimum_units then
    raise exception 'STAKE_BELOW_MINIMUM';
  end if;

  -- 已有进行中的轮次则拒绝
  if exists (select 1 from rounds
             where user_id = p_user_id and level = p_level and settled_at is null) then
    raise exception 'ROUND_ACTIVE';
  end if;

  -- 账户总额（余额 + 在投本金）需达到账户门槛
  select coalesce(sum(stake_units), 0) into v_reserved
    from rounds where user_id = p_user_id and settled_at is null;
  v_total_balance := v_user.balance_units + v_reserved;
  if v_total_balance < v_config.entry_units then
    raise exception 'ENTRY_THRESHOLD';
  end if;

  if v_user.balance_units < p_stake_units then
    raise exception 'INSUFFICIENT_BALANCE';
  end if;

  v_profit := round(p_stake_units * v_config.profit_percent / 100.0);
  v_started_at := extract(epoch from now())::bigint;

  insert into rounds (
    id, user_id, level, stake_units, profit_units, method,
    win_probability_bp, profit_percent, result,
    started_at, ends_at, settled_at,
    fairness_secret, fairness_commitment, fairness_nonce, fairness_draw
  ) values (
    p_id, p_user_id, p_level, p_stake_units, v_profit, p_method,
    v_config.win_probability_bp, v_config.profit_percent, p_result,
    v_started_at, v_started_at + v_config.duration_seconds, null,
    p_fairness_secret, p_fairness_commitment, p_fairness_nonce, p_fairness_draw
  );

  update users set balance_units = balance_units - p_stake_units where id = p_user_id;

  return json_build_object(
    'stake_units', p_stake_units,
    'profit_units', v_profit,
    'win_probability_bp', v_config.win_probability_bp,
    'profit_percent', v_config.profit_percent,
    'ends_at', v_started_at + v_config.duration_seconds
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 结算到期轮次：写入 settled_at，赢则返还本金 + 收益，并记录资金流水
--   返回 本次结算的轮次数组
-- ---------------------------------------------------------------------
create or replace function public.settle_due_rounds(p_user_id bigint)
returns setof rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round rounds%rowtype;
begin
  for v_round in
    select * from rounds
     where user_id = p_user_id and settled_at is null and ends_at <= extract(epoch from now())::bigint
     order by started_at
     for update
  loop
    if v_round.result = 1 then
      update users
         set balance_units = balance_units + v_round.stake_units + v_round.profit_units
       where id = v_round.user_id;
    end if;

    update rounds set settled_at = extract(epoch from now())::bigint where id = v_round.id;

    insert into wallet_events (user_id, kind, amount_units, created_at)
    values (
      v_round.user_id,
      case when v_round.result = 1 then 'mint-win' else 'mint-loss' end,
      case when v_round.result = 1 then v_round.profit_units else v_round.stake_units end,
      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );

    return next v_round;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 审核充值 / 提现申请
--   p_request_id  申请 ID
--   p_admin_id    审核人
--   p_decision    'approve' | 'cancel'
--   p_reason      审核备注
--   返回            'approved' | 'cancelled'
-- ---------------------------------------------------------------------
create or replace function public.resolve_wallet_request(
  p_request_id text,
  p_admin_id bigint,
  p_decision text,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request wallet_requests%rowtype;
  v_status  text;
  v_now     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if p_decision not in ('approve', 'cancel') then
    raise exception 'INVALID_DECISION';
  end if;

  select * into v_request from wallet_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'ALREADY_RESOLVED';
  end if;

  v_status := case when p_decision = 'approve' then 'approved' else 'cancelled' end;

  if p_decision = 'approve' then
    insert into wallet_events (user_id, kind, amount_units, created_at)
    values (
      v_request.user_id,
      case when v_request.kind = 'deposit' then 'deposit' else 'withdraw' end,
      v_request.amount_units,
      v_now
    );

    if v_request.kind = 'deposit' then
      update users set balance_units = balance_units + v_request.amount_units
       where id = v_request.user_id;
    end if;
  else
    -- 取消提现：解冻本金（提现在提交时已扣减余额）
    if v_request.kind = 'withdraw' then
      update users set balance_units = balance_units + v_request.amount_units
       where id = v_request.user_id;

      insert into wallet_events (user_id, kind, amount_units, created_at)
      values (v_request.user_id, 'withdraw-release', v_request.amount_units, v_now);
    end if;
  end if;

  update wallet_requests
     set status = v_status,
         resolved_at = v_now,
         resolved_by = p_admin_id,
         resolution_note = p_reason
   where id = p_request_id;

  return v_status;
end;
$$;

-- ---------------------------------------------------------------------
-- 提交提现申请：冻结本金（提交即扣减余额）
-- ---------------------------------------------------------------------
create or replace function public.submit_withdraw(
  p_request_id text,
  p_user_id bigint,
  p_amount_units integer,
  p_address text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from users where id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;
  if v_user.balance_units < p_amount_units then
    raise exception 'INSUFFICIENT_BALANCE';
  end if;

  update users set balance_units = balance_units - p_amount_units where id = p_user_id;

  insert into wallet_requests (id, user_id, kind, amount_units, address, status, created_at)
  values (
    p_request_id, p_user_id, 'withdraw', p_amount_units, p_address, 'pending',
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 管理员调整余额
-- ---------------------------------------------------------------------
create or replace function public.adjust_user_balance(
  p_user_id bigint,
  p_delta_units integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      users%rowtype;
  v_new_bal   integer;
  v_now       text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  select * into v_user from users where id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  v_new_bal := v_user.balance_units + p_delta_units;
  if v_new_bal < 0 then
    raise exception 'NEGATIVE_BALANCE';
  end if;
  if v_new_bal > 9000000000000 then
    raise exception 'BALANCE_OVERFLOW';
  end if;

  update users set balance_units = v_new_bal where id = p_user_id;

  insert into wallet_events (user_id, kind, amount_units, created_at)
  values (
    p_user_id,
    case when p_delta_units >= 0 then 'admin-credit' else 'admin-debit' end,
    abs(p_delta_units),
    v_now
  );

  return v_new_bal;
end;
$$;

-- ---------------------------------------------------------------------
-- 领取典藏收益：清零 earned_units 并把收益加到余额
-- ---------------------------------------------------------------------
create or replace function public.claim_earnings(p_user_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_now   text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  select coalesce(sum(earned_units), 0) into v_total
    from holdings where user_id = p_user_id;
  if v_total <= 0 then
    return 0;
  end if;

  update users set balance_units = balance_units + v_total where id = p_user_id;
  update holdings set earned_units = 0 where user_id = p_user_id;

  insert into wallet_events (user_id, kind, amount_units, created_at)
  values (p_user_id, 'collectible-reward', v_total, v_now);

  return v_total;
end;
$$;

-- 仅 service_role 可执行
revoke all on function public.place_round(
  text, bigint, integer, integer, integer, integer, text, text, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.settle_due_rounds(bigint) from public, anon, authenticated;
revoke all on function public.resolve_wallet_request(text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.submit_withdraw(text, bigint, integer, text) from public, anon, authenticated;
revoke all on function public.adjust_user_balance(bigint, integer, text) from public, anon, authenticated;
revoke all on function public.claim_earnings(bigint) from public, anon, authenticated;
