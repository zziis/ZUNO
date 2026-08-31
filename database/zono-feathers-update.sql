-- Zono Feather Economy Update
-- شغّله مرة واحدة داخل Supabase SQL Editor.
-- لا يحذف points أو gems القديمة؛ فقط يتوقف التطبيق عن استخدامها.

alter table public.profiles
  add column if not exists feathers bigint not null default 0 check (feathers >= 0),
  add column if not exists active_bird text not null default 'classic_gold',
  add column if not exists feather_last_claim timestamptz,
  add column if not exists bio varchar(220);

create table if not exists public.bird_inventory (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null,
  purchased_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.bird_inventory enable row level security;

drop policy if exists "own bird inventory read" on public.bird_inventory;
create policy "own bird inventory read"
on public.bird_inventory for select
to authenticated
using (user_id = auth.uid());

revoke insert, update, delete on public.bird_inventory from anon, authenticated;
grant select on public.bird_inventory to authenticated;

create or replace function public.zono_bird_price(p_item_id text)
returns bigint
language sql
immutable
as $$
  select case p_item_id
    when 'classic_gold' then 0
    when 'emerald' then 150
    when 'royal_blue' then 250
    when 'crimson_phoenix' then 400
    else null
  end;
$$;

create or replace function public.zono_bird_inventory()
returns table(item_id text)
language sql
security definer
set search_path = public
as $$
  select bi.item_id
  from public.bird_inventory bi
  where bi.user_id = auth.uid()
  order by bi.purchased_at;
$$;

create or replace function public.zono_buy_bird(p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price bigint;
  v_balance bigint;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  v_price := public.zono_bird_price(p_item_id);
  if v_price is null or v_price <= 0 then
    raise exception 'هذا الطائر غير متاح للشراء';
  end if;

  if exists(
    select 1 from public.bird_inventory
    where user_id = auth.uid() and item_id = p_item_id
  ) then
    raise exception 'هذا الطائر مملوك بالفعل';
  end if;

  select feathers into v_balance
  from public.profiles
  where id = auth.uid()
  for update;

  if coalesce(v_balance, 0) < v_price then
    raise exception 'رصيد الريش غير كافٍ';
  end if;

  update public.profiles
  set feathers = feathers - v_price,
      updated_at = now()
  where id = auth.uid();

  insert into public.bird_inventory(user_id, item_id)
  values(auth.uid(), p_item_id);

  return jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'price', v_price,
    'feathers', v_balance - v_price
  );
end;
$$;

create or replace function public.zono_equip_bird(p_item_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  if p_item_id <> 'classic_gold'
     and not exists(
       select 1 from public.bird_inventory
       where user_id = auth.uid() and item_id = p_item_id
     ) then
    raise exception 'يجب شراء هذا الطائر أولاً';
  end if;

  if public.zono_bird_price(p_item_id) is null then
    raise exception 'طائر غير معروف';
  end if;

  update public.profiles
  set active_bird = p_item_id,
      updated_at = now()
  where id = auth.uid();
end;
$$;

create or replace function public.zono_claim_daily_feathers()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last timestamptz;
  v_balance bigint;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  select feather_last_claim, feathers
  into v_last, v_balance
  from public.profiles
  where id = auth.uid()
  for update;

  if v_last is not null and v_last > now() - interval '24 hours' then
    raise exception 'لقد استلمت مكافأة الريش، عد بعد اكتمال 24 ساعة';
  end if;

  update public.profiles
  set feathers = feathers + 60,
      feather_last_claim = now(),
      updated_at = now()
  where id = auth.uid()
  returning feathers into v_balance;

  return jsonb_build_object(
    'ok', true,
    'reward', 60,
    'feathers', v_balance
  );
end;
$$;

create or replace function public.zono_update_bio(p_bio text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  update public.profiles
  set bio = left(nullif(trim(coalesce(p_bio,'')), ''), 220),
      updated_at = now()
  where id = auth.uid();
end;
$$;

grant execute on function public.zono_bird_inventory() to authenticated;
grant execute on function public.zono_buy_bird(text) to authenticated;
grant execute on function public.zono_equip_bird(text) to authenticated;
grant execute on function public.zono_claim_daily_feathers() to authenticated;
grant execute on function public.zono_update_bio(text) to authenticated;

notify pgrst, 'reload schema';
