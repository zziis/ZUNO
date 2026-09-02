-- ZONO NAME THEMES + BIRD THEMES
-- Run once in Supabase SQL Editor.
-- Name themes use feathers. Bird themes use seeds.

alter table public.profiles
  add column if not exists active_name_theme text not null default 'basic';

alter table public.profiles
  add column if not exists active_bird_theme text not null default 'bird_basic';

create table if not exists public.zono_name_theme_ownership(
  user_id uuid not null references public.profiles(id) on delete cascade,
  theme_key text not null,
  purchased_at timestamptz not null default now(),
  primary key(user_id,theme_key)
);

create table if not exists public.zono_bird_theme_ownership(
  user_id uuid not null references public.profiles(id) on delete cascade,
  theme_key text not null,
  purchased_at timestamptz not null default now(),
  primary key(user_id,theme_key)
);

alter table public.zono_name_theme_ownership enable row level security;
alter table public.zono_bird_theme_ownership enable row level security;
revoke all on public.zono_name_theme_ownership from anon,authenticated;
revoke all on public.zono_bird_theme_ownership from anon,authenticated;

create or replace function public.zono_cosmetic_theme_state()
returns jsonb
language sql
security definer
set search_path=public
as $$
  select jsonb_build_object(
    'active_name_theme',coalesce(p.active_name_theme,'basic'),
    'active_bird_theme',coalesce(p.active_bird_theme,'bird_basic'),
    'owned_name_themes',
      coalesce((select jsonb_agg(n.theme_key order by n.theme_key)
                from public.zono_name_theme_ownership n
                where n.user_id=auth.uid()),'[]'::jsonb),
    'owned_bird_themes',
      coalesce((select jsonb_agg(b.theme_key order by b.theme_key)
                from public.zono_bird_theme_ownership b
                where b.user_id=auth.uid()),'[]'::jsonb)
  )
  from public.profiles p
  where p.id=auth.uid();
$$;
grant execute on function public.zono_cosmetic_theme_state() to authenticated;

create or replace function public.zono_buy_name_theme(p_theme_key text)
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
    when 'celestial' then 1000 when 'royal' then 2000 when 'legendary' then 3000
    when 'emerald_name' then 4000 when 'crimson_name' then 5000 when 'electric_name' then 6000
    when 'aurora_name' then 7000 when 'dragon_name' then 8000 when 'phantom_name' then 9000
    when 'imperial_name' then 10000 else null end;

  if v_price is null then raise exception 'ثيم الاسم غير موجود'; end if;

  if exists(select 1 from public.zono_name_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key) then
    return jsonb_build_object('ok',true,'already_owned',true);
  end if;

  select * into v_profile from public.profiles where id=auth.uid() for update;
  if coalesce(v_profile.feathers,0)<v_price then raise exception 'رصيد الريش غير كافٍ'; end if;

  update public.profiles set feathers=coalesce(feathers,0)-v_price where id=auth.uid();
  insert into public.zono_name_theme_ownership(user_id,theme_key) values(auth.uid(),p_theme_key);

  return jsonb_build_object('ok',true,'price',v_price);
end;
$$;
grant execute on function public.zono_buy_name_theme(text) to authenticated;

create or replace function public.zono_apply_name_theme(p_theme_key text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if p_theme_key <> 'basic'
     and not exists(select 1 from public.zono_name_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key)
  then raise exception 'يجب شراء ثيم الاسم أولاً'; end if;

  update public.profiles set active_name_theme=p_theme_key where id=auth.uid();
  return jsonb_build_object('ok',true,'active_name_theme',p_theme_key);
end;
$$;
grant execute on function public.zono_apply_name_theme(text) to authenticated;

create or replace function public.zono_buy_bird_theme(p_theme_key text)
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
    when 'bird_ember' then 500 when 'bird_frost' then 1000 when 'bird_storm' then 1500
    when 'bird_moon' then 2000 when 'bird_sun' then 2500 when 'bird_neon' then 3000
    when 'bird_phantom' then 3500 when 'bird_dragon' then 4000 when 'bird_royal' then 4500
    when 'bird_celestial' then 5000 else null end;

  if v_price is null then raise exception 'ثيم الطائر غير موجود'; end if;

  if exists(select 1 from public.zono_bird_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key) then
    return jsonb_build_object('ok',true,'already_owned',true);
  end if;

  select * into v_profile from public.profiles where id=auth.uid() for update;
  if coalesce(v_profile.seeds,0)<v_price then raise exception 'رصيد البذور غير كافٍ'; end if;

  update public.profiles set seeds=coalesce(seeds,0)-v_price where id=auth.uid();
  insert into public.zono_bird_theme_ownership(user_id,theme_key) values(auth.uid(),p_theme_key);

  return jsonb_build_object('ok',true,'price',v_price);
end;
$$;
grant execute on function public.zono_buy_bird_theme(text) to authenticated;

create or replace function public.zono_apply_bird_theme(p_theme_key text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists(select 1 from public.zono_bird_theme_ownership where user_id=auth.uid() and theme_key=p_theme_key)
  then raise exception 'يجب شراء ثيم الطائر أولاً'; end if;

  update public.profiles set active_bird_theme=p_theme_key where id=auth.uid();
  return jsonb_build_object('ok',true,'active_bird_theme',p_theme_key);
end;
$$;
grant execute on function public.zono_apply_bird_theme(text) to authenticated;

-- Existing purchased bird skins are free bird themes.
create or replace function public.zono_apply_owned_bird_skin_theme(p_skin_id text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if p_skin_id='classic_gold' then
    update public.profiles set active_bird_theme='owned:classic_gold' where id=auth.uid();
    return jsonb_build_object('ok',true);
  end if;

  if not exists(
    select 1 from public.zono_feather_inventory i
    where i.user_id=auth.uid() and i.item_id=p_skin_id
  ) then
    raise exception 'هذا الطائر غير مملوك للحساب';
  end if;

  update public.profiles set active_bird_theme='owned:'||p_skin_id where id=auth.uid();
  return jsonb_build_object('ok',true,'active_bird_theme','owned:'||p_skin_id);
end;
$$;
grant execute on function public.zono_apply_owned_bird_skin_theme(text) to authenticated;

notify pgrst,'reload schema';
