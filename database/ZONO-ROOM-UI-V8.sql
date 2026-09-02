-- ZONO ROOM UI V8 - run once after V6. Safe replacement for failed V7.
alter table public.profiles add column if not exists account_level integer not null default 1;
alter table public.zono_rooms add column if not exists welcome_message text not null default 'أهلاً بك في الغرفة';

drop function if exists public.zono_room_members(bigint);
create function public.zono_room_members(p_room_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare rid bigint; owner_uuid uuid; result jsonb;
begin
 if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
 select r.id,r.owner_id into rid,owner_uuid from public.zono_rooms r where r.public_id=p_room_public_id;
 if rid is null then raise exception 'الروم غير موجود'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('public_id',p.public_id,'display_name',p.display_name,'avatar',p.avatar_url,'account_level',coalesce(p.account_level,1),'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),'name_theme',coalesce(p.active_name_theme,'basic'),'is_owner',p.id=owner_uuid,'is_moderator',exists(select 1 from public.zono_room_moderators rm where rm.room_id=rid and rm.user_id=p.id),'is_manager',false) order by rp.joined_at),'[]'::jsonb)
 into result from public.zono_room_presence rp join public.profiles p on p.id=rp.user_id where rp.room_id=rid and rp.last_seen_at>now()-interval '45 seconds';
 return result;
end $$;
grant execute on function public.zono_room_members(bigint) to authenticated;

create or replace function public.zono_room_owner_info_v8(p_room_public_id bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.zono_rooms%rowtype; p public.profiles%rowtype;
begin
 select * into r from public.zono_rooms where public_id=p_room_public_id; if r.id is null then raise exception 'الروم غير موجود'; end if;
 select * into p from public.profiles where id=r.owner_id;
 return jsonb_build_object('public_id',p.public_id,'display_name',p.display_name,'avatar',p.avatar_url,'account_level',coalesce(p.account_level,1),'avatar_frame',coalesce(p.active_avatar_frame,'frame_basic'),'name_theme',coalesce(p.active_name_theme,'basic'),'welcome_message',r.welcome_message);
end $$;
grant execute on function public.zono_room_owner_info_v8(bigint) to authenticated;

create or replace function public.zono_room_update_welcome_v8(p_room_public_id bigint,p_welcome_message text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare rid bigint;
begin
 select id into rid from public.zono_rooms where public_id=p_room_public_id and owner_id=auth.uid(); if rid is null then raise exception 'للمالك فقط'; end if;
 update public.zono_rooms set welcome_message=left(trim(coalesce(p_welcome_message,'')),300) where id=rid;
 return jsonb_build_object('ok',true);
end $$;
grant execute on function public.zono_room_update_welcome_v8(bigint,text) to authenticated;

-- allow room owner OR moderator to register uploaded MP3
create or replace function public.zono_music_add_track_v2(p_room_public_id bigint,p_title text,p_url text,p_storage_path text,p_duration_seconds integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.zono_rooms%rowtype; new_id bigint; staff boolean;
begin
 select * into r from public.zono_rooms where public_id=p_room_public_id; if r.id is null then raise exception 'الروم غير موجود'; end if;
 staff:=r.owner_id=auth.uid() or exists(select 1 from public.zono_room_moderators rm where rm.room_id=r.id and rm.user_id=auth.uid());
 if not staff then raise exception 'رفع الأغاني للمالك والمشرفين فقط'; end if;
 insert into public.zono_room_music_tracks(room_id,owner_id,title,url,storage_path,duration_seconds,sort_order) values(r.id,auth.uid(),trim(p_title),trim(p_url),p_storage_path,greatest(1,p_duration_seconds),coalesce((select max(sort_order)+1 from public.zono_room_music_tracks where room_id=r.id),1)) returning id into new_id;
 insert into public.zono_room_music_state(room_id) values(r.id) on conflict(room_id) do nothing;
 return jsonb_build_object('ok',true,'song_id',new_id);
end $$;
grant execute on function public.zono_music_add_track_v2(bigint,text,text,text,integer) to authenticated;

notify pgrst,'reload schema';
