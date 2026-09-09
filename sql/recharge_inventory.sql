-- ZUNO recharge card inventory
create table if not exists public.zono_recharge_codes (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('asiacell','zain')),
  amount_iqd integer not null check (amount_iqd in (2000,5000,10000,15000,25000)),
  code_value text not null unique,
  status text not null default 'available' check (status in ('available','used')),
  buyer_id uuid references auth.users(id) on delete set null,
  sold_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists zono_recharge_codes_stock_idx on public.zono_recharge_codes(provider, amount_iqd, status, created_at);
alter table public.zono_recharge_codes enable row level security;
revoke all on public.zono_recharge_codes from anon, authenticated;

create or replace function public.zono_recharge_availability(p_provider text)
returns table(amount_iqd integer, available_count bigint)
language sql security definer set search_path=public as $$
  select v.amount_iqd,
         count(c.id) filter (where c.status='available')::bigint
  from (values (2000),(5000),(10000),(15000),(25000)) v(amount_iqd)
  left join public.zono_recharge_codes c on c.amount_iqd=v.amount_iqd and c.provider=p_provider
  group by v.amount_iqd order by v.amount_iqd;
$$;

grant execute on function public.zono_recharge_availability(text) to authenticated;

create or replace function public.zono_developer_add_recharge_code(p_provider text,p_amount_iqd integer,p_code_value text)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_uid uuid:=auth.uid(); v_public_id bigint;
begin
  select public_id into v_public_id from public.profiles where id=v_uid;
  if coalesce(v_public_id,0)<>1 then raise exception 'DEVELOPER_ONLY'; end if;
  if p_provider not in ('asiacell','zain') or p_amount_iqd not in (2000,5000,10000,15000,25000) then raise exception 'INVALID_CARD'; end if;
  if length(trim(coalesce(p_code_value,'')))<3 then raise exception 'INVALID_CODE'; end if;
  insert into public.zono_recharge_codes(provider,amount_iqd,code_value,created_by)
  values(p_provider,p_amount_iqd,trim(p_code_value),v_uid);
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_developer_add_recharge_code(text,integer,text) to authenticated;

drop function if exists public.zono_developer_recharge_codes(text,integer);
create function public.zono_developer_recharge_codes(p_provider text,p_amount_iqd integer)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_uid uuid:=auth.uid();
  v_public_id_text text;
  v_items jsonb;
begin
  select public_id::text into v_public_id_text from public.profiles where id=v_uid;
  if coalesce(v_public_id_text,'') <> '1' then raise exception 'DEVELOPER_ONLY'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'code_value', c.code_value,
    'status', c.status,
    'buyer_public_id', p.public_id,
    'sold_at', c.sold_at,
    'created_at', c.created_at
  ) order by (c.status='available') desc, c.created_at desc), '[]'::jsonb)
  into v_items
  from public.zono_recharge_codes c
  left join public.profiles p on p.id=c.buyer_id
  where c.provider=p_provider and c.amount_iqd=p_amount_iqd;

  return jsonb_build_object('items', v_items);
end $$;
grant execute on function public.zono_developer_recharge_codes(text,integer) to authenticated;

create or replace function public.zono_purchase_recharge_code(p_provider text,p_amount_iqd integer)
returns table(ok boolean,message text,code_value text,remaining_seeds bigint)
language plpgsql security definer set search_path=public as $$
declare
  v_uid uuid:=auth.uid(); v_code public.zono_recharge_codes%rowtype; v_seeds bigint; v_price bigint:=5000;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select seeds into v_seeds from public.profiles where id=v_uid for update;
  if coalesce(v_seeds,0)<v_price then return query select false,'بذورك غير كافية',null::text,coalesce(v_seeds,0); return; end if;

  select * into v_code from public.zono_recharge_codes
  where provider=p_provider and amount_iqd=p_amount_iqd and status='available'
  order by created_at asc
  for update skip locked limit 1;
  if v_code.id is null then return query select false,'نفد الرصيد حالياً، يرجى المحاولة لاحقاً',null::text,coalesce(v_seeds,0); return; end if;

  update public.profiles set seeds=seeds-v_price where id=v_uid;
  update public.zono_recharge_codes set status='used',buyer_id=v_uid,sold_at=now() where id=v_code.id;
  insert into public.zono_notifications(user_id,kind,title,body,amount,is_read)
  values(v_uid,'company_message','تم شراء رصيد',
    format('تم شراء رصيد %s دينار من %s. كود الرصيد: %s',p_amount_iqd,case when p_provider='asiacell' then 'آسيا سيل' else 'زين العراق' end,v_code.code_value),
    p_amount_iqd,false);

  return query select true,'تم شراء الرصيد وإرسال الكود إلى الشعارات',v_code.code_value,(v_seeds-v_price)::bigint;
end $$;
grant execute on function public.zono_purchase_recharge_code(text,integer) to authenticated;

-- FIX 2026-09-09:
-- 1) Cast buyer public_id to bigint so the developer inventory RPC always matches its declared return type.
-- 2) Recharge delivery uses the existing company_message notification kind for compatibility with current ZUNO notification schemas.
