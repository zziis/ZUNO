-- ZONO V9 — Room replies + Follow + Friend requests + Owner social card
-- Run once in Supabase SQL Editor.

-- Room reply link.
alter table public.zono_room_messages
  add column if not exists reply_to_id bigint references public.zono_room_messages(id) on delete set null;

create index if not exists zono_room_messages_reply_idx
  on public.zono_room_messages(reply_to_id);

-- Social follow relation.
create table if not exists public.zono_follows(
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(follower_id,following_id),
  check(follower_id<>following_id)
);

alter table public.zono_follows enable row level security;
revoke all on public.zono_follows from anon,authenticated;

-- Friend requests with a short explanatory note.
create table if not exists public.zono_friend_requests(
  id bigserial primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  note text not null default '',
  status text not null default 'pending' check(status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check(sender_id<>receiver_id)
);

create unique index if not exists zono_friend_pending_unique
on public.zono_friend_requests(
  least(sender_id,receiver_id),
  greatest(sender_id,receiver_id)
)
where status in ('pending','accepted');

alter table public.zono_friend_requests enable row level security;
revoke all on public.zono_friend_requests from anon,authenticated;


-- Send a room text message, optionally replying to another room message.
create or replace function public.zono_send_room_message_v9(
  p_room_public_id bigint,
  p_message text,
  p_reply_to_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
  new_id bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select id into rid
  from public.zono_rooms
  where public_id=p_room_public_id;

  if rid is null then raise exception 'الروم غير موجود'; end if;

  if public.zono_room_is_muted(rid,auth.uid()) then
    raise exception 'MUTED';
  end if;

  if length(trim(coalesce(p_message,'')))<1 then
    raise exception 'الرسالة فارغة';
  end if;

  if length(trim(p_message))>1000 then
    raise exception 'الرسالة طويلة جداً';
  end if;

  if p_reply_to_id is not null and not exists(
    select 1 from public.zono_room_messages
    where id=p_reply_to_id and room_id=rid
  ) then
    p_reply_to_id:=null;
  end if;

  insert into public.zono_room_messages(
    room_id,sender_id,message_type,content,reply_to_id
  )
  values(
    rid,auth.uid(),'text',trim(p_message),p_reply_to_id
  )
  returning id into new_id;

  return jsonb_build_object('ok',true,'id',new_id);
end $$;

grant execute on function public.zono_send_room_message_v9(bigint,text,bigint)
to authenticated;


-- Room message list including reply preview and sender level/profile.
create or replace function public.zono_room_messages_v9(
  p_room_public_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select id into rid
  from public.zono_rooms
  where public_id=p_room_public_id;

  if rid is null then raise exception 'الروم غير موجود'; end if;

  delete from public.zono_room_messages
  where room_id=rid
    and created_at<now()-interval '60 minutes';

  select coalesce(jsonb_agg(row_data order by (row_data->>'id')::bigint desc),'[]'::jsonb)
  into result
  from (
    select jsonb_build_object(
      'id',m.id,
      'message_type',m.message_type,
      'content',m.content,
      'created_at',m.created_at,
      'media_url',m.media_url,
      'media_duration',m.media_duration,
      'sender_public_id',p.public_id,
      'sender_name',p.display_name,
      'sender_avatar',p.avatar_url,
      'sender_level',coalesce(p.account_level,1),
      'name_theme',coalesce(p.active_name_theme,'basic'),
      'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),
      'reply_to_id',m.reply_to_id,
      'reply_sender_name',rp.display_name,
      'reply_content',
        case
          when rm.message_type='voice' then '🎙️ بصمة صوتية'
          else left(coalesce(rm.content,''),120)
        end
    ) as row_data
    from public.zono_room_messages m
    left join public.profiles p on p.id=m.sender_id
    left join public.zono_room_messages rm on rm.id=m.reply_to_id
    left join public.profiles rp on rp.id=rm.sender_id
    where m.room_id=rid
    order by m.id desc
    limit 100
  ) q;

  return result;
end $$;

grant execute on function public.zono_room_messages_v9(bigint)
to authenticated;


-- Owner card with follower count, follow state and friendship state.
create or replace function public.zono_room_owner_social_v9(
  p_room_public_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  p public.profiles%rowtype;
  followers bigint;
  following_state boolean;
  friendship text;
  progress integer;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select * into r
  from public.zono_rooms
  where public_id=p_room_public_id;

  if r.id is null then raise exception 'الروم غير موجود'; end if;

  select * into p
  from public.profiles
  where id=r.owner_id;

  select count(*) into followers
  from public.zono_follows
  where following_id=p.id;

  select exists(
    select 1 from public.zono_follows
    where follower_id=auth.uid() and following_id=p.id
  ) into following_state;

  select coalesce((
    select fr.status
    from public.zono_friend_requests fr
    where ((fr.sender_id=auth.uid() and fr.receiver_id=p.id)
       or  (fr.receiver_id=auth.uid() and fr.sender_id=p.id))
    order by fr.id desc
    limit 1
  ),'none') into friendship;

  -- Visual level progress until a dedicated XP column is added.
  progress:=least(100,greatest(0,mod(coalesce(p.account_level,1)*17,100)));

  return jsonb_build_object(
    'public_id',p.public_id,
    'display_name',p.display_name,
    'avatar',p.avatar_url,
    'account_level',coalesce(p.account_level,1),
    'level_progress',progress,
    'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),
    'followers_count',followers,
    'is_following',following_state,
    'friend_status',friendship,
    'is_self',p.id=auth.uid(),
    'welcome_message',coalesce(r.welcome_message,'أهلاً بك في الغرفة')
  );
end $$;

grant execute on function public.zono_room_owner_social_v9(bigint)
to authenticated;


create or replace function public.zono_toggle_follow_v9(
  p_target_public_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  target_id uuid;
  now_following boolean;
  followers bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select id into target_id
  from public.profiles
  where public_id=p_target_public_id;

  if target_id is null then raise exception 'الحساب غير موجود'; end if;
  if target_id=auth.uid() then raise exception 'لا يمكنك متابعة نفسك'; end if;

  if exists(
    select 1 from public.zono_follows
    where follower_id=auth.uid() and following_id=target_id
  ) then
    delete from public.zono_follows
    where follower_id=auth.uid() and following_id=target_id;
    now_following:=false;
  else
    insert into public.zono_follows(follower_id,following_id)
    values(auth.uid(),target_id)
    on conflict do nothing;
    now_following:=true;
  end if;

  select count(*) into followers
  from public.zono_follows
  where following_id=target_id;

  return jsonb_build_object(
    'ok',true,
    'is_following',now_following,
    'followers_count',followers
  );
end $$;

grant execute on function public.zono_toggle_follow_v9(bigint)
to authenticated;


create or replace function public.zono_send_friend_request_v9(
  p_target_public_id bigint,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  target_id uuid;
  existing_status text;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select id into target_id
  from public.profiles
  where public_id=p_target_public_id;

  if target_id is null then raise exception 'الحساب غير موجود'; end if;
  if target_id=auth.uid() then raise exception 'لا يمكنك إضافة نفسك'; end if;

  select fr.status into existing_status
  from public.zono_friend_requests fr
  where ((fr.sender_id=auth.uid() and fr.receiver_id=target_id)
     or  (fr.receiver_id=auth.uid() and fr.sender_id=target_id))
    and fr.status in ('pending','accepted')
  order by fr.id desc
  limit 1;

  if existing_status='accepted' then
    return jsonb_build_object('ok',true,'status','accepted');
  elsif existing_status='pending' then
    return jsonb_build_object('ok',true,'status','pending');
  end if;

  insert into public.zono_friend_requests(sender_id,receiver_id,note,status)
  values(auth.uid(),target_id,left(coalesce(p_note,''),250),'pending');

  return jsonb_build_object('ok',true,'status','pending');
end $$;

grant execute on function public.zono_send_friend_request_v9(bigint,text)
to authenticated;

notify pgrst,'reload schema';
