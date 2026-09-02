-- ZONO room chat retention update
-- Run this ONCE in Supabase SQL Editor after your previous ZONO room SQL files.
-- Keeps only the last 60 minutes on the server. The front-end shows 10 messages on entry
-- and can show up to 100 new/recent messages while the user remains in the room.

create or replace function public.zono_room_messages(p_room_public_id bigint)
returns table(
  id bigint,
  message_type text,
  content text,
  created_at timestamptz,
  sender_public_id bigint,
  sender_name text,
  sender_avatar text,
  name_theme text,
  avatar_frame text,
  media_url text,
  media_duration integer
)
language plpgsql
security definer
set search_path=public
as $$
declare rid bigint;
begin
  select r.id into rid from public.zono_rooms r where r.public_id=p_room_public_id;
  if rid is null then raise exception 'الروم غير موجود'; end if;

  -- Automatic cleanup whenever room history is refreshed.
  delete from public.zono_room_messages m
  where m.room_id=rid and m.created_at < now()-interval '60 minutes';

  return query
  select m.id,m.message_type,m.content,m.created_at,
         p.public_id,p.display_name,p.avatar_url,
         coalesce(p.active_name_theme,'basic'),coalesce(p.active_avatar_frame,'frame_basic'),
         m.media_url,m.media_duration
  from public.zono_room_messages m
  left join public.profiles p on p.id=m.sender_id
  where m.room_id=rid
    and m.created_at >= now()-interval '60 minutes'
  order by m.id desc
  limit 100;
end $$;
grant execute on function public.zono_room_messages(bigint) to authenticated;

-- Owner/moderator deletion. This replaces the RPC only if the same table/helper names
-- already used by your ZONO room backend are present (as in the current project).
create or replace function public.zono_delete_room_message(p_room_public_id bigint,p_message_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare rid bigint;
begin
  select id into rid from public.zono_rooms where public_id=p_room_public_id;
  if rid is null then raise exception 'الروم غير موجود'; end if;
  if not public.zono_room_is_staff(rid,auth.uid()) then raise exception 'لا تملك صلاحية حذف الرسائل'; end if;
  delete from public.zono_room_messages where id=p_message_id and room_id=rid;
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_delete_room_message(bigint,bigint) to authenticated;

notify pgrst,'reload schema';
