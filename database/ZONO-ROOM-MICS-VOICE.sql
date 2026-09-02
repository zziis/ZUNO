-- ZONO ROOM MICS + BACKGROUND + COMMUNITY GUIDELINES + VOICE NOTES
-- Run AFTER ZONO-REAL-ROOMS-GIFTS.sql
-- Mic packages: 4/6/8 seats for 60 days = 4,000 / 6,000 / 8,000 seeds.

create extension if not exists pgcrypto;

alter table public.zono_rooms add column if not exists background_url text;
alter table public.zono_rooms add column if not exists guidelines_text text not null default
'مرحباً بك؛ يرجى الالتزام بالاحترام، منع السب والإساءة، وعدم نشر محتوى مخالف.';
alter table public.zono_rooms add column if not exists mic_count integer not null default 0;
alter table public.zono_rooms add column if not exists mic_expires_at timestamptz;
alter table public.zono_rooms add column if not exists mic_mode text not null default 'open';

do $$
begin
  if not exists(select 1 from pg_constraint where conname='zono_rooms_mic_count_check') then
    alter table public.zono_rooms add constraint zono_rooms_mic_count_check check(mic_count in (0,4,6,8));
  end if;
  if not exists(select 1 from pg_constraint where conname='zono_rooms_mic_mode_check') then
    alter table public.zono_rooms add constraint zono_rooms_mic_mode_check check(mic_mode in ('open','approval','closed'));
  end if;
end $$;

create table if not exists public.zono_room_mic_seats(
  room_id bigint not null references public.zono_rooms(id) on delete cascade,
  seat_no integer not null,
  user_id uuid references public.profiles(id) on delete set null,
  is_locked boolean not null default false,
  occupied_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(room_id,seat_no)
);

create table if not exists public.zono_room_mic_requests(
  room_id bigint not null references public.zono_rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key(room_id,user_id)
);

alter table public.zono_room_mic_seats enable row level security;
alter table public.zono_room_mic_requests enable row level security;
revoke all on public.zono_room_mic_seats from anon,authenticated;
revoke all on public.zono_room_mic_requests from anon,authenticated;

-- Expand room messages for voice notes.
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid='public.zono_room_messages'::regclass and contype='c'
    and pg_get_constraintdef(oid) ilike '%message_type%';
  if cname is not null then execute format('alter table public.zono_room_messages drop constraint %I',cname); end if;
exception when others then null;
end $$;

alter table public.zono_room_messages add column if not exists media_url text;
alter table public.zono_room_messages add column if not exists media_duration integer;

alter table public.zono_room_messages
  add constraint zono_room_messages_type_check
  check(message_type in ('text','gift','system','voice'));

-- Voice bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('room-voice','room-voice',true,8388608,array['audio/webm','audio/mp4','audio/mpeg','audio/ogg'])
on conflict(id) do update
set public=true,file_size_limit=8388608,allowed_mime_types=array['audio/webm','audio/mp4','audio/mpeg','audio/ogg'];

drop policy if exists "zono_room_voice_auth_insert" on storage.objects;
create policy "zono_room_voice_auth_insert"
on storage.objects for insert to authenticated
with check(bucket_id='room-voice' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists "zono_room_voice_public_read" on storage.objects;
create policy "zono_room_voice_public_read"
on storage.objects for select to public
using(bucket_id='room-voice');

-- Owner: background and guidelines.
create or replace function public.zono_room_set_background(p_room_public_id bigint,p_background_url text)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id for update;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if r.owner_id<>auth.uid() then raise exception 'تغيير الخلفية متاح لمالك الروم فقط'; end if;
  update public.zono_rooms set background_url=nullif(trim(coalesce(p_background_url,'')),'') where id=r.id;
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_set_background(bigint,text) to authenticated;

create or replace function public.zono_room_set_guidelines(p_room_public_id bigint,p_guidelines text)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id for update;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if r.owner_id<>auth.uid() then raise exception 'تعديل الإرشادات متاح لمالك الروم فقط'; end if;
  if length(trim(coalesce(p_guidelines,'')))<5 or length(p_guidelines)>500 then raise exception 'الإرشادات غير صالحة'; end if;
  update public.zono_rooms set guidelines_text=trim(p_guidelines) where id=r.id;
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_set_guidelines(bigint,text) to authenticated;

-- Buy mic package (owner only) and activate for 60 days.
create or replace function public.zono_room_buy_mic_package(p_room_public_id bigint,p_mic_count integer)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype; p public.profiles%rowtype; price bigint;
begin
  if p_mic_count not in (4,6,8) then raise exception 'الباقة غير موجودة'; end if;
  price:=p_mic_count*1000;

  select * into r from public.zono_rooms where public_id=p_room_public_id for update;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if r.owner_id<>auth.uid() then raise exception 'شراء المايكات متاح لمالك الروم فقط'; end if;

  select * into p from public.profiles where id=auth.uid() for update;
  if coalesce(p.seeds,0)<price then raise exception 'رصيد البذور غير كافٍ'; end if;

  update public.profiles set seeds=coalesce(seeds,0)-price where id=auth.uid();
  update public.zono_rooms
  set mic_count=p_mic_count,mic_expires_at=now()+interval '60 days'
  where id=r.id;

  delete from public.zono_room_mic_seats where room_id=r.id and seat_no>p_mic_count;
  insert into public.zono_room_mic_seats(room_id,seat_no)
  select r.id,n from generate_series(1,p_mic_count)n
  on conflict(room_id,seat_no) do nothing;

  return jsonb_build_object('ok',true,'mic_count',p_mic_count,'price',price,'expires_at',now()+interval '60 days');
end $$;
grant execute on function public.zono_room_buy_mic_package(bigint,integer) to authenticated;

create or replace function public.zono_room_set_mic_mode(p_room_public_id bigint,p_mode text)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype;
begin
  if p_mode not in ('open','approval','closed') then raise exception 'الوضع غير صحيح'; end if;
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if not public.zono_room_is_staff(r.id,auth.uid()) then raise exception 'لا تملك صلاحية إدارة المايكات'; end if;
  update public.zono_rooms set mic_mode=p_mode where id=r.id;
  return jsonb_build_object('ok',true,'mic_mode',p_mode);
end $$;
grant execute on function public.zono_room_set_mic_mode(bigint,text) to authenticated;

create or replace function public.zono_room_mic_state(p_room_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype; active boolean; seats jsonb; requests jsonb;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  active:=r.mic_count>0 and r.mic_expires_at is not null and r.mic_expires_at>now();

  if not active then
    update public.zono_room_mic_seats set user_id=null,occupied_at=null,updated_at=now() where room_id=r.id and user_id is not null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'seat_no',s.seat_no,'is_locked',s.is_locked,'user_public_id',p.public_id,
    'display_name',p.display_name,'avatar',p.avatar_url
  ) order by s.seat_no),'[]'::jsonb)
  into seats
  from public.zono_room_mic_seats s
  left join public.profiles p on p.id=s.user_id
  where s.room_id=r.id and s.seat_no<=greatest(r.mic_count,0);

  if public.zono_room_is_staff(r.id,auth.uid()) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_public_id',p.public_id,'display_name',p.display_name,'avatar',p.avatar_url,'created_at',q.created_at
    ) order by q.created_at),'[]'::jsonb)
    into requests
    from public.zono_room_mic_requests q
    join public.profiles p on p.id=q.user_id
    where q.room_id=r.id and q.status='pending';
  else
    requests:='[]'::jsonb;
  end if;

  return jsonb_build_object(
    'active',active,'mic_count',case when active then r.mic_count else 0 end,
    'mic_expires_at',r.mic_expires_at,'mic_mode',r.mic_mode,'seats',seats,'requests',requests
  );
end $$;
grant execute on function public.zono_room_mic_state(bigint) to authenticated;

create or replace function public.zono_room_request_mic(p_room_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype; seat integer;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id for update;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if not(r.mic_count>0 and r.mic_expires_at>now()) then raise exception 'لا توجد باقة مايك فعالة'; end if;
  if public.zono_room_is_muted(r.id,auth.uid()) then raise exception 'MUTED'; end if;
  if exists(select 1 from public.zono_room_mic_seats where room_id=r.id and user_id=auth.uid()) then
    return jsonb_build_object('ok',true,'status','seated');
  end if;
  if r.mic_mode='closed' then raise exception 'المايكات مقفلة'; end if;

  if r.mic_mode='approval' then
    insert into public.zono_room_mic_requests(room_id,user_id,status,created_at)
    values(r.id,auth.uid(),'pending',now())
    on conflict(room_id,user_id) do update set status='pending',created_at=now();
    return jsonb_build_object('ok',true,'status','pending');
  end if;

  select s.seat_no into seat from public.zono_room_mic_seats s
  where s.room_id=r.id and s.seat_no<=r.mic_count and not s.is_locked and s.user_id is null
  order by s.seat_no for update skip locked limit 1;
  if seat is null then raise exception 'لا يوجد مايك فارغ'; end if;
  update public.zono_room_mic_seats set user_id=auth.uid(),occupied_at=now(),updated_at=now()
  where room_id=r.id and seat_no=seat;
  return jsonb_build_object('ok',true,'status','seated','seat_no',seat);
end $$;
grant execute on function public.zono_room_request_mic(bigint) to authenticated;

create or replace function public.zono_room_leave_mic(p_room_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare rid bigint;
begin
  select id into rid from public.zono_rooms where public_id=p_room_public_id;
  update public.zono_room_mic_seats set user_id=null,occupied_at=null,updated_at=now()
  where room_id=rid and user_id=auth.uid();
  delete from public.zono_room_mic_requests where room_id=rid and user_id=auth.uid();
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_leave_mic(bigint) to authenticated;

create or replace function public.zono_room_mic_request_action(p_room_public_id bigint,p_target_public_id bigint,p_approve boolean)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype; target uuid; seat integer;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id for update;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if not public.zono_room_is_staff(r.id,auth.uid()) then raise exception 'لا تملك الصلاحية'; end if;
  select id into target from public.profiles where public_id=p_target_public_id;
  if target is null then raise exception 'المستخدم غير موجود'; end if;

  if not p_approve then
    delete from public.zono_room_mic_requests where room_id=r.id and user_id=target;
    return jsonb_build_object('ok',true,'status','rejected');
  end if;

  select s.seat_no into seat from public.zono_room_mic_seats s
  where s.room_id=r.id and s.seat_no<=r.mic_count and not s.is_locked and s.user_id is null
  order by s.seat_no for update skip locked limit 1;
  if seat is null then raise exception 'لا يوجد مايك فارغ'; end if;

  update public.zono_room_mic_seats set user_id=target,occupied_at=now(),updated_at=now()
  where room_id=r.id and seat_no=seat;
  delete from public.zono_room_mic_requests where room_id=r.id and user_id=target;
  return jsonb_build_object('ok',true,'status','approved','seat_no',seat);
end $$;
grant execute on function public.zono_room_mic_request_action(bigint,bigint,boolean) to authenticated;

create or replace function public.zono_room_mic_set_seat_lock(p_room_public_id bigint,p_seat_no integer,p_locked boolean)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if not public.zono_room_is_staff(r.id,auth.uid()) then raise exception 'لا تملك الصلاحية'; end if;
  if p_seat_no<1 or p_seat_no>r.mic_count then raise exception 'رقم المايك غير صحيح'; end if;
  update public.zono_room_mic_seats
  set is_locked=p_locked,user_id=case when p_locked then null else user_id end,
      occupied_at=case when p_locked then null else occupied_at end,updated_at=now()
  where room_id=r.id and seat_no=p_seat_no;
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_mic_set_seat_lock(bigint,integer,boolean) to authenticated;

create or replace function public.zono_room_mic_remove_user(p_room_public_id bigint,p_target_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.zono_rooms%rowtype; target uuid;
begin
  select * into r from public.zono_rooms where public_id=p_room_public_id;
  if r.id is null then raise exception 'الروم غير موجود'; end if;
  if not public.zono_room_is_staff(r.id,auth.uid()) then raise exception 'لا تملك الصلاحية'; end if;
  select id into target from public.profiles where public_id=p_target_public_id;
  update public.zono_room_mic_seats set user_id=null,occupied_at=null,updated_at=now()
  where room_id=r.id and user_id=target;
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_mic_remove_user(bigint,bigint) to authenticated;

-- Voice note insert. Muted users cannot send.
create or replace function public.zono_send_room_voice(p_room_public_id bigint,p_media_url text,p_duration integer)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare rid bigint;
begin
  select id into rid from public.zono_rooms where public_id=p_room_public_id;
  if rid is null then raise exception 'الروم غير موجود'; end if;
  if public.zono_room_is_muted(rid,auth.uid()) then raise exception 'MUTED'; end if;
  if p_duration<1 or p_duration>60 then raise exception 'مدة البصمة يجب ألا تتجاوز 60 ثانية'; end if;
  if length(coalesce(p_media_url,''))<8 then raise exception 'رابط الصوت غير صالح'; end if;

  insert into public.zono_room_messages(room_id,sender_id,message_type,content,media_url,media_duration)
  values(rid,auth.uid(),'voice','بصمة صوتية',p_media_url,p_duration);
  return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_send_room_voice(bigint,text,integer) to authenticated;

-- Staff can delete text/voice/gift events when needed.
create or replace function public.zono_delete_room_message(p_room_public_id bigint,p_message_id bigint)
returns jsonb language plpgsql security definer set search_path=public
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

-- Return extended room data on entry.
create or replace function public.zono_enter_room(p_room_public_id bigint,p_password text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare v_room public.zono_rooms%rowtype; v_restrict public.zono_room_restrictions%rowtype;
        v_owner boolean; v_mod boolean; v_count bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select * into v_room from public.zono_rooms where public_id=p_room_public_id;
  if v_room.id is null then raise exception 'الروم غير موجود'; end if;

  select * into v_restrict from public.zono_room_restrictions where room_id=v_room.id and user_id=auth.uid();
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

  return jsonb_build_object(
    'ok',true,'public_id',v_room.public_id,'name',v_room.name,'bio',v_room.bio,
    'image_url',v_room.image_url,'background_url',v_room.background_url,
    'guidelines_text',v_room.guidelines_text,'is_locked',v_room.is_locked,
    'is_owner',v_owner,'is_moderator',v_mod,'active_members',v_count,
    'mic_count',v_room.mic_count,'mic_expires_at',v_room.mic_expires_at,'mic_mode',v_room.mic_mode
  );
end $$;
grant execute on function public.zono_enter_room(bigint,text) to authenticated;

-- Messages now return voice metadata too.
drop function if exists public.zono_room_messages(bigint);
create function public.zono_room_messages(p_room_public_id bigint)
returns table(
  id bigint,message_type text,content text,created_at timestamptz,
  sender_public_id bigint,sender_name text,sender_avatar text,name_theme text,avatar_frame text,
  media_url text,media_duration integer
)
language sql security definer set search_path=public
as $$
  select m.id,m.message_type,m.content,m.created_at,
         p.public_id,p.display_name,p.avatar_url,
         coalesce(p.active_name_theme,'basic'),coalesce(p.active_avatar_frame,'frame_basic'),
         m.media_url,m.media_duration
  from public.zono_room_messages m
  join public.zono_rooms r on r.id=m.room_id
  left join public.profiles p on p.id=m.sender_id
  where r.public_id=p_room_public_id
  order by m.id desc
  limit 150;
$$;
grant execute on function public.zono_room_messages(bigint) to authenticated;

notify pgrst,'reload schema';
