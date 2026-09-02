-- ZONO ROOM UI V3 + PROFILE AVATAR + FAVORITES
-- Run AFTER the previous room/mic/live-audio SQL files.

alter table public.zono_rooms
  add column if not exists room_level integer not null default 1;

create table if not exists public.zono_room_favorites(
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id bigint not null references public.zono_rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,room_id)
);

alter table public.zono_room_favorites enable row level security;
revoke all on public.zono_room_favorites from anon,authenticated;

create or replace function public.zono_toggle_room_favorite(p_room_public_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare rid bigint; exists_now boolean;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select id into rid from public.zono_rooms where public_id=p_room_public_id;
  if rid is null then raise exception 'الروم غير موجود'; end if;

  select exists(
    select 1 from public.zono_room_favorites
    where user_id=auth.uid() and room_id=rid
  ) into exists_now;

  if exists_now then
    delete from public.zono_room_favorites where user_id=auth.uid() and room_id=rid;
    return jsonb_build_object('ok',true,'is_favorite',false);
  else
    insert into public.zono_room_favorites(user_id,room_id) values(auth.uid(),rid)
    on conflict do nothing;
    return jsonb_build_object('ok',true,'is_favorite',true);
  end if;
end $$;
grant execute on function public.zono_toggle_room_favorite(bigint) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-avatars','profile-avatars',true,4194304,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update
set public=true,file_size_limit=4194304,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];

drop policy if exists "zono_profile_avatar_auth_insert" on storage.objects;
create policy "zono_profile_avatar_auth_insert"
on storage.objects for insert to authenticated
with check(bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists "zono_profile_avatar_public_read" on storage.objects;
create policy "zono_profile_avatar_public_read"
on storage.objects for select to public
using(bucket_id='profile-avatars');

create or replace function public.zono_update_avatar(p_avatar_url text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  if length(trim(coalesce(p_avatar_url,'')))<8 then raise exception 'رابط الصورة غير صالح'; end if;
  update public.profiles set avatar_url=trim(p_avatar_url) where id=auth.uid();
  return jsonb_build_object('ok',true,'avatar_url',trim(p_avatar_url));
end $$;
grant execute on function public.zono_update_avatar(text) to authenticated;

create or replace function public.zono_enter_room(p_room_public_id bigint,p_password text default null)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_room public.zono_rooms%rowtype;
  v_restrict public.zono_room_restrictions%rowtype;
  v_owner boolean;
  v_mod boolean;
  v_count bigint;
  v_fav boolean;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select * into v_room from public.zono_rooms where public_id=p_room_public_id;
  if v_room.id is null then raise exception 'الروم غير موجود'; end if;

  select * into v_restrict from public.zono_room_restrictions
  where room_id=v_room.id and user_id=auth.uid();

  if coalesce(v_restrict.banned,false) then raise exception 'ROOM_BANNED'; end if;
  if v_restrict.kicked_until is not null and v_restrict.kicked_until>now() then raise exception 'ROOM_KICKED'; end if;

  v_owner:=v_room.owner_id=auth.uid();
  v_mod:=exists(select 1 from public.zono_room_moderators where room_id=v_room.id and user_id=auth.uid());

  if v_room.is_locked and not(v_owner or v_mod) then
    if p_password is null or p_password='' then raise exception 'ROOM_PASSWORD_REQUIRED'; end if;
    if v_room.password_hash is null or extensions.crypt(p_password,v_room.password_hash)<>v_room.password_hash
      then raise exception 'ROOM_PASSWORD_INVALID'; end if;
  end if;

  insert into public.zono_room_presence(room_id,user_id,joined_at,last_seen_at)
  values(v_room.id,auth.uid(),now(),now())
  on conflict(room_id,user_id) do update set last_seen_at=now();

  select count(*) into v_count from public.zono_room_presence
  where room_id=v_room.id and last_seen_at>now()-interval '45 seconds';

  select exists(select 1 from public.zono_room_favorites f where f.user_id=auth.uid() and f.room_id=v_room.id)
  into v_fav;

  return jsonb_build_object(
    'ok',true,'public_id',v_room.public_id,'name',v_room.name,'bio',v_room.bio,
    'image_url',v_room.image_url,'background_url',v_room.background_url,
    'guidelines_text',v_room.guidelines_text,'is_locked',v_room.is_locked,
    'is_owner',v_owner,'is_moderator',v_mod,'active_members',v_count,
    'mic_count',v_room.mic_count,'mic_expires_at',v_room.mic_expires_at,'mic_mode',v_room.mic_mode,
    'room_level',coalesce(v_room.room_level,1),'is_favorite',v_fav
  );
end $$;

grant execute on function public.zono_enter_room(bigint,text) to authenticated;
notify pgrst,'reload schema';
