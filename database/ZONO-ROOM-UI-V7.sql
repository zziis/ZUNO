-- ZONO ROOM UI V7
-- Run once AFTER ZONO-FIX-V6.sql

alter table public.profiles
  add column if not exists account_level integer not null default 1;

create or replace function public.zono_room_members(p_room_public_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
  owner_uuid uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select r.id,r.owner_id into rid,owner_uuid
  from public.zono_rooms r
  where r.public_id=p_room_public_id;

  if rid is null then raise exception 'الروم غير موجود'; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'public_id',p.public_id,
      'display_name',p.display_name,
      'avatar',p.avatar_url,
      'account_level',coalesce(p.account_level,1),
      'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),
      'name_theme',coalesce(p.active_name_theme,'basic'),
      'is_owner',p.id=owner_uuid,
      'is_moderator',exists(select 1 from public.zono_room_moderators rm where rm.room_id=rid and rm.user_id=p.id),
      'is_manager',false
    )
    order by
      case when p.id=owner_uuid then 0
           when exists(select 1 from public.zono_room_moderators rm2 where rm2.room_id=rid and rm2.user_id=p.id) then 1
           else 2 end,
      rp.joined_at
  ),'[]'::jsonb)
  into result
  from public.zono_room_presence rp
  join public.profiles p on p.id=rp.user_id
  where rp.room_id=rid
    and rp.last_seen_at>now()-interval '45 seconds';

  return result;
end $$;

grant execute on function public.zono_room_members(bigint) to authenticated;

create or replace function public.zono_room_owner_info_v7(p_room_public_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  p public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  select * into p from public.profiles where id=r.owner_id;

  return jsonb_build_object(
    'public_id',p.public_id,
    'display_name',p.display_name,
    'avatar',p.avatar_url,
    'account_level',coalesce(p.account_level,1),
    'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),
    'name_theme',coalesce(p.active_name_theme,'basic')
  );
end $$;

grant execute on function public.zono_room_owner_info_v7(bigint) to authenticated;

create or replace function public.zono_room_messages_window(
  p_room_public_id bigint,
  p_limit integer default 10
)
returns table(
  id bigint,
  message_type text,
  content text,
  created_at timestamptz,
  sender_public_id bigint,
  sender_name text,
  sender_avatar text,
  sender_level integer,
  name_theme text,
  avatar_frame text,
  media_url text,
  media_duration integer
)
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
  lim integer;
begin
  select r.id into rid from public.zono_rooms r where r.public_id=p_room_public_id;
  if rid is null then raise exception 'الروم غير موجود'; end if;

  delete from public.zono_room_messages m
  where m.room_id=rid and m.created_at<now()-interval '60 minutes';

  lim:=least(100,greatest(1,coalesce(p_limit,10)));

  return query
  select m.id,m.message_type,m.content,m.created_at,
         p.public_id,p.display_name,p.avatar_url,coalesce(p.account_level,1),
         coalesce(p.active_name_theme,'basic'),coalesce(p.active_avatar_frame,'frame_basic'),
         m.media_url,m.media_duration
  from public.zono_room_messages m
  left join public.profiles p on p.id=m.sender_id
  where m.room_id=rid and m.created_at>=now()-interval '60 minutes'
  order by m.id desc
  limit lim;
end $$;

grant execute on function public.zono_room_messages_window(bigint,integer) to authenticated;

notify pgrst,'reload schema';
