-- ZONO THEMES + READ RECEIPTS
-- Run ONCE in Supabase SQL Editor.

alter table public.profiles
  add column if not exists active_theme text not null default 'classic_night';

alter table public.profiles
  add column if not exists read_receipts_enabled boolean not null default true;

create table if not exists public.zono_theme_ownership(
  user_id uuid not null references public.profiles(id) on delete cascade,
  theme_key text not null,
  purchased_at timestamptz not null default now(),
  primary key(user_id,theme_key)
);

alter table public.zono_theme_ownership enable row level security;
revoke all on public.zono_theme_ownership from anon,authenticated;

create or replace function public.zono_theme_state()
returns jsonb
language sql
security definer
set search_path=public
as $$
  select jsonb_build_object(
    'active_theme',coalesce(p.active_theme,'classic_night'),
    'read_receipts_enabled',coalesce(p.read_receipts_enabled,true),
    'owned_themes',
      coalesce(
        (select jsonb_agg(o.theme_key order by o.theme_key)
         from public.zono_theme_ownership o
         where o.user_id=auth.uid()),
        '[]'::jsonb
      )
  )
  from public.profiles p
  where p.id=auth.uid();
$$;
grant execute on function public.zono_theme_state() to authenticated;

create or replace function public.zono_buy_theme(p_theme_key text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_price bigint;
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  v_price:=case p_theme_key
    when 'lunar' then 400
    when 'solar' then 600
    when 'royal_bird' then 800
    else null
  end;

  if v_price is null then raise exception 'هذا الثيم مجاني أو غير موجود'; end if;

  if exists(select 1 from public.zono_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key) then
    return jsonb_build_object('ok',true,'already_owned',true,'price',0);
  end if;

  select * into v_profile from public.profiles where id=auth.uid() for update;
  if v_profile.id is null then raise exception 'الحساب غير موجود'; end if;
  if coalesce(v_profile.feathers,0)<v_price then raise exception 'رصيد الريش غير كافٍ'; end if;

  update public.profiles set feathers=coalesce(feathers,0)-v_price where id=auth.uid();
  insert into public.zono_theme_ownership(user_id,theme_key) values(auth.uid(),p_theme_key) on conflict do nothing;

  return jsonb_build_object('ok',true,'theme_key',p_theme_key,'price',v_price);
end;
$$;
grant execute on function public.zono_buy_theme(text) to authenticated;

create or replace function public.zono_apply_theme(p_theme_key text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  if p_theme_key not in ('classic_night','daylight','lunar','solar','royal_bird') then
    raise exception 'الثيم غير موجود';
  end if;

  if p_theme_key not in ('classic_night','daylight')
     and not exists(select 1 from public.zono_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key) then
    raise exception 'يجب شراء هذا الثيم أولاً';
  end if;

  update public.profiles set active_theme=p_theme_key where id=auth.uid();
  return jsonb_build_object('ok',true,'active_theme',p_theme_key);
end;
$$;
grant execute on function public.zono_apply_theme(text) to authenticated;

create or replace function public.zono_set_read_receipts(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  update public.profiles set read_receipts_enabled=coalesce(p_enabled,true) where id=auth.uid();
  return jsonb_build_object('ok',true,'read_receipts_enabled',coalesce(p_enabled,true));
end;
$$;
grant execute on function public.zono_set_read_receipts(boolean) to authenticated;

notify pgrst,'reload schema';
