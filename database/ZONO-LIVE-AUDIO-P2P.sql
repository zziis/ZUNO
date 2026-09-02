-- ZONO LIVE AUDIO P2P SAFETY UPDATE
-- Run AFTER ZONO-ROOM-MICS-VOICE.sql
-- WebRTC signalling itself uses Supabase Realtime Broadcast and does not require a paid voice service.

create or replace function public.zono_room_restriction_drop_mic()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if coalesce(new.banned,false)
     or coalesce(new.muted_permanent,false)
     or (new.muted_until is not null and new.muted_until > now())
     or (new.kicked_until is not null and new.kicked_until > now())
  then
    update public.zono_room_mic_seats
    set user_id=null, occupied_at=null, updated_at=now()
    where room_id=new.room_id and user_id=new.user_id;

    delete from public.zono_room_mic_requests
    where room_id=new.room_id and user_id=new.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists zono_room_restriction_drop_mic_trg
on public.zono_room_restrictions;

create trigger zono_room_restriction_drop_mic_trg
after insert or update
on public.zono_room_restrictions
for each row
execute function public.zono_room_restriction_drop_mic();

notify pgrst,'reload schema';
