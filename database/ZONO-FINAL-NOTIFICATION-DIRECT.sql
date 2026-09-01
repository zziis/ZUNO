-- ZONO FINAL NOTIFICATION FIX
-- Run this file ONCE in Supabase SQL Editor.

alter table public.zono_notifications enable row level security;

-- Remove only policies with our fixed names, then recreate them.
drop policy if exists "zono_notifications_select_own" on public.zono_notifications;
drop policy if exists "zono_notifications_update_own" on public.zono_notifications;

create policy "zono_notifications_select_own"
on public.zono_notifications
for select
to authenticated
using (user_id = auth.uid());

create policy "zono_notifications_update_own"
on public.zono_notifications
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant select on public.zono_notifications to authenticated;
grant update (is_read) on public.zono_notifications to authenticated;

-- Keep notifications for seven days only.
create or replace function public.zono_notifications_cleanup_7d()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.zono_notifications
  where created_at < now() - interval '7 days';

  return new;
end;
$$;

drop trigger if exists trg_zono_notifications_cleanup_7d
on public.zono_notifications;

create trigger trg_zono_notifications_cleanup_7d
after insert on public.zono_notifications
for each statement
execute function public.zono_notifications_cleanup_7d();

notify pgrst, 'reload schema';

-- TEST AFTER LOGIN AS THE RECEIVER:
-- The website now reads directly from public.zono_notifications.
