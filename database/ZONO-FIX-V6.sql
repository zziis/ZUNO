-- ZONO FIX V6
-- Fixes:
-- 1) room voice note upload/save after preview
-- 2) room MP3 library persistence
-- Run ONCE after the previous ZONO SQL files.

-- ============================================================
-- Voice notes: normalize Storage and save RPC
-- ============================================================
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'room-voice','room-voice',true,8388608,
  array['audio/webm','audio/mp4','audio/mpeg','audio/ogg']
)
on conflict(id) do update
set public=true,
    file_size_limit=8388608,
    allowed_mime_types=array['audio/webm','audio/mp4','audio/mpeg','audio/ogg'];

drop policy if exists "zono_room_voice_auth_insert" on storage.objects;
create policy "zono_room_voice_auth_insert"
on storage.objects for insert to authenticated
with check(
  bucket_id='room-voice'
  and (storage.foldername(name))[1]=auth.uid()::text
);

drop policy if exists "zono_room_voice_public_read" on storage.objects;
create policy "zono_room_voice_public_read"
on storage.objects for select to public
using(bucket_id='room-voice');

drop policy if exists "zono_room_voice_owner_delete" on storage.objects;
create policy "zono_room_voice_owner_delete"
on storage.objects for delete to authenticated
using(
  bucket_id='room-voice'
  and (storage.foldername(name))[1]=auth.uid()::text
);

create or replace function public.zono_send_room_voice_v2(
  p_room_public_id bigint,
  p_media_url text,
  p_duration integer
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select id into rid
  from public.zono_rooms
  where public_id=p_room_public_id;

  if rid is null then raise exception 'الروم غير موجود'; end if;

  if public.zono_room_is_muted(rid,auth.uid()) then
    raise exception 'MUTED';
  end if;

  if p_duration<1 or p_duration>60 then
    raise exception 'مدة البصمة يجب ألا تتجاوز 60 ثانية';
  end if;

  if length(trim(coalesce(p_media_url,'')))<8 then
    raise exception 'رابط الصوت غير صالح';
  end if;

  insert into public.zono_room_messages(
    room_id,sender_id,message_type,content,media_url,media_duration
  )
  values(
    rid,auth.uid(),'voice','بصمة صوتية',trim(p_media_url),p_duration
  );

  return jsonb_build_object('ok',true);
end $$;

grant execute on function public.zono_send_room_voice_v2(bigint,text,integer)
to authenticated;


-- ============================================================
-- Music: robust persistent tables + new RPC names
-- ============================================================
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'room-music','room-music',true,15728640,
  array['audio/mpeg']
)
on conflict(id) do update
set public=true,
    file_size_limit=15728640,
    allowed_mime_types=array['audio/mpeg'];

drop policy if exists "zono_room_music_owner_insert" on storage.objects;
drop policy if exists "zono_room_music_auth_insert" on storage.objects;

create policy "zono_room_music_owner_insert"
on storage.objects for insert to authenticated
with check(
  bucket_id='room-music'
  and (storage.foldername(name))[1]=auth.uid()::text
);

drop policy if exists "zono_room_music_public_read" on storage.objects;
create policy "zono_room_music_public_read"
on storage.objects for select to public
using(bucket_id='room-music');

drop policy if exists "zono_room_music_owner_delete" on storage.objects;
create policy "zono_room_music_owner_delete"
on storage.objects for delete to authenticated
using(
  bucket_id='room-music'
  and (storage.foldername(name))[1]=auth.uid()::text
);

create table if not exists public.zono_room_music_tracks(
  id bigserial primary key,
  room_id bigint not null references public.zono_rooms(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  url text not null,
  storage_path text,
  duration_seconds integer not null default 0,
  sort_order bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists zono_room_music_tracks_room_sort_idx
on public.zono_room_music_tracks(room_id,sort_order,id);

create table if not exists public.zono_room_music_state(
  room_id bigint primary key references public.zono_rooms(id) on delete cascade,
  song_id bigint references public.zono_room_music_tracks(id) on delete set null,
  status text not null default 'stopped',
  position_seconds numeric not null default 0,
  started_at timestamptz,
  repeat_mode text not null default 'all',
  updated_at timestamptz not null default now()
);

alter table public.zono_room_music_tracks enable row level security;
alter table public.zono_room_music_state enable row level security;
revoke all on public.zono_room_music_tracks from anon,authenticated;
revoke all on public.zono_room_music_state from anon,authenticated;

create or replace function public.zono_music_add_track_v2(
  p_room_public_id bigint,
  p_title text,
  p_url text,
  p_storage_path text,
  p_duration_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  new_id bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select * into r
  from public.zono_rooms
  where public_id=p_room_public_id
  for update;

  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if r.owner_id<>auth.uid() then raise exception 'رفع الأغاني لمالك الروم فقط'; end if;
  if length(trim(coalesce(p_title,'')))<1 then raise exception 'اسم الأغنية غير صالح'; end if;
  if p_duration_seconds<1 then raise exception 'مدة الأغنية غير صالحة'; end if;

  insert into public.zono_room_music_tracks(
    room_id,owner_id,title,url,storage_path,duration_seconds,sort_order
  )
  values(
    r.id,auth.uid(),trim(p_title),trim(p_url),p_storage_path,p_duration_seconds,
    coalesce(
      (select max(sort_order)+1 from public.zono_room_music_tracks where room_id=r.id),
      1
    )
  )
  returning id into new_id;

  insert into public.zono_room_music_state(room_id)
  values(r.id)
  on conflict(room_id) do nothing;

  return jsonb_build_object('ok',true,'song_id',new_id);
end $$;

grant execute on function public.zono_music_add_track_v2(bigint,text,text,text,integer)
to authenticated;


create or replace function public.zono_music_delete_track_v2(
  p_room_public_id bigint,
  p_song_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  stored_path text;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if r.owner_id<>auth.uid() then raise exception 'حذف الأغاني لمالك الروم فقط'; end if;

  select storage_path into stored_path
  from public.zono_room_music_tracks
  where id=p_song_id and room_id=r.id;

  update public.zono_room_music_state
  set song_id=null,status='stopped',position_seconds=0,started_at=null,updated_at=now()
  where room_id=r.id and song_id=p_song_id;

  delete from public.zono_room_music_tracks
  where id=p_song_id and room_id=r.id;

  return jsonb_build_object('ok',true,'storage_path',stored_path);
end $$;

grant execute on function public.zono_music_delete_track_v2(bigint,bigint)
to authenticated;


create or replace function public.zono_music_control_v2(
  p_room_public_id bigint,
  p_action text,
  p_song_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  current_state public.zono_room_music_state%rowtype;
  next_id bigint;
  current_position numeric;
  is_staff boolean;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;

  is_staff :=
    r.owner_id=auth.uid()
    or exists(
      select 1 from public.zono_room_moderators
      where room_id=r.id and user_id=auth.uid()
    );

  if not is_staff then raise exception 'التحكم بالموسيقى للمالك والمشرفين فقط'; end if;

  insert into public.zono_room_music_state(room_id)
  values(r.id)
  on conflict(room_id) do nothing;

  select * into current_state
  from public.zono_room_music_state
  where room_id=r.id
  for update;

  if current_state.status='playing' and current_state.started_at is not null then
    current_position:=greatest(
      0,
      current_state.position_seconds + extract(epoch from(now()-current_state.started_at))
    );
  else
    current_position:=greatest(0,current_state.position_seconds);
  end if;

  if p_action='play_song' then
    if not exists(
      select 1 from public.zono_room_music_tracks
      where id=p_song_id and room_id=r.id
    ) then raise exception 'الأغنية غير موجودة'; end if;

    update public.zono_room_music_state
    set song_id=p_song_id,status='playing',position_seconds=0,started_at=now(),updated_at=now()
    where room_id=r.id;

  elsif p_action='pause' then
    update public.zono_room_music_state
    set status='paused',position_seconds=current_position,started_at=null,updated_at=now()
    where room_id=r.id;

  elsif p_action='resume' then
    if current_state.song_id is null then
      select id into next_id
      from public.zono_room_music_tracks
      where room_id=r.id
      order by sort_order,id limit 1;

      if next_id is null then raise exception 'لا توجد أغاني'; end if;

      update public.zono_room_music_state
      set song_id=next_id,position_seconds=0
      where room_id=r.id;
    end if;

    update public.zono_room_music_state
    set status='playing',started_at=now(),updated_at=now()
    where room_id=r.id;

  elsif p_action in ('next','ended') then
    if p_action='ended'
       and current_state.repeat_mode='one'
       and current_state.song_id is not null
    then
      next_id:=current_state.song_id;
    else
      select t.id into next_id
      from public.zono_room_music_tracks t
      where t.room_id=r.id
        and t.sort_order>(
          select coalesce(x.sort_order,-1)
          from public.zono_room_music_tracks x
          where x.id=current_state.song_id
        )
      order by t.sort_order,t.id
      limit 1;

      if next_id is null then
        select id into next_id
        from public.zono_room_music_tracks
        where room_id=r.id
        order by sort_order,id
        limit 1;
      end if;
    end if;

    if next_id is null then
      update public.zono_room_music_state
      set song_id=null,status='stopped',position_seconds=0,started_at=null,updated_at=now()
      where room_id=r.id;
    else
      update public.zono_room_music_state
      set song_id=next_id,status='playing',position_seconds=0,started_at=now(),updated_at=now()
      where room_id=r.id;
    end if;

  elsif p_action='previous' then
    select t.id into next_id
    from public.zono_room_music_tracks t
    where t.room_id=r.id
      and t.sort_order<(
        select coalesce(x.sort_order,9223372036854775807)
        from public.zono_room_music_tracks x
        where x.id=current_state.song_id
      )
    order by t.sort_order desc,t.id desc
    limit 1;

    if next_id is null then
      select id into next_id
      from public.zono_room_music_tracks
      where room_id=r.id
      order by sort_order desc,id desc
      limit 1;
    end if;

    if next_id is not null then
      update public.zono_room_music_state
      set song_id=next_id,status='playing',position_seconds=0,started_at=now(),updated_at=now()
      where room_id=r.id;
    end if;

  elsif p_action='repeat_one' then
    update public.zono_room_music_state
    set repeat_mode='one',updated_at=now()
    where room_id=r.id;

  elsif p_action='repeat_all' then
    update public.zono_room_music_state
    set repeat_mode='all',updated_at=now()
    where room_id=r.id;

  else
    raise exception 'أمر موسيقى غير معروف';
  end if;

  return jsonb_build_object('ok',true);
end $$;

grant execute on function public.zono_music_control_v2(bigint,text,bigint)
to authenticated;


create or replace function public.zono_music_library_v2(
  p_room_public_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  r public.zono_rooms%rowtype;
  s public.zono_room_music_state%rowtype;
  songs jsonb;
  state_json jsonb;
  is_staff boolean;
  duration_sec integer;
  elapsed numeric;
  next_id bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;

  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;

  is_staff :=
    r.owner_id=auth.uid()
    or exists(
      select 1 from public.zono_room_moderators
      where room_id=r.id and user_id=auth.uid()
    );

  insert into public.zono_room_music_state(room_id)
  values(r.id)
  on conflict(room_id) do nothing;

  select * into s
  from public.zono_room_music_state
  where room_id=r.id
  for update;

  if s.song_id is not null and s.status='playing' and s.started_at is not null then
    select duration_seconds into duration_sec
    from public.zono_room_music_tracks
    where id=s.song_id and room_id=r.id;

    elapsed:=s.position_seconds + extract(epoch from(now()-s.started_at));

    if duration_sec is not null and duration_sec>0 and elapsed>=duration_sec then
      if s.repeat_mode='one' then
        update public.zono_room_music_state
        set position_seconds=0,started_at=now(),updated_at=now()
        where room_id=r.id;
      else
        select t.id into next_id
        from public.zono_room_music_tracks t
        where t.room_id=r.id
          and t.sort_order>(
            select coalesce(x.sort_order,-1)
            from public.zono_room_music_tracks x
            where x.id=s.song_id
          )
        order by t.sort_order,t.id
        limit 1;

        if next_id is null then
          select id into next_id
          from public.zono_room_music_tracks
          where room_id=r.id
          order by sort_order,id limit 1;
        end if;

        if next_id is null then
          update public.zono_room_music_state
          set song_id=null,status='stopped',position_seconds=0,started_at=null,updated_at=now()
          where room_id=r.id;
        else
          update public.zono_room_music_state
          set song_id=next_id,status='playing',position_seconds=0,started_at=now(),updated_at=now()
          where room_id=r.id;
        end if;
      end if;

      select * into s
      from public.zono_room_music_state
      where room_id=r.id;
    end if;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',t.id,
        'title',t.title,
        'url',t.url,
        'duration_seconds',t.duration_seconds,
        'sort_order',t.sort_order
      )
      order by t.sort_order,t.id
    ),
    '[]'::jsonb
  )
  into songs
  from public.zono_room_music_tracks t
  where t.room_id=r.id;

  select jsonb_build_object(
    'song_id',st.song_id,
    'status',st.status,
    'position_seconds',st.position_seconds,
    'started_at',st.started_at,
    'repeat_mode',st.repeat_mode,
    'updated_at',st.updated_at,
    'song_title',tr.title,
    'song_url',tr.url,
    'duration_seconds',tr.duration_seconds,
    'server_now',now()
  )
  into state_json
  from public.zono_room_music_state st
  left join public.zono_room_music_tracks tr on tr.id=st.song_id
  where st.room_id=r.id;

  return jsonb_build_object(
    'state',coalesce(state_json,'{}'::jsonb),
    'songs',songs,
    'is_owner',r.owner_id=auth.uid(),
    'is_staff',is_staff
  );
end $$;

grant execute on function public.zono_music_library_v2(bigint)
to authenticated;

notify pgrst,'reload schema';
