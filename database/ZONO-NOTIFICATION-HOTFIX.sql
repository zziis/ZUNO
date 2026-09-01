-- ZONO HOTFIX: restore seed-transfer notifications
-- Run this whole file ONCE in Supabase SQL Editor.

-- Keep the notifications RPC tolerant of older seed-transfer kind names.
drop function if exists public.zono_my_notifications();

create function public.zono_my_notifications()
returns table(
  id bigint,
  kind text,
  title text,
  body text,
  sender_public_id bigint,
  amount bigint,
  is_read boolean,
  created_at timestamptz
)
language plpgsql
security definer
set search_path=public
as $$
begin
  -- Keep only one week of notifications.
  delete from public.zono_notifications
  where created_at < now() - interval '7 days';

  return query
  select
    n.id,
    n.kind,
    n.title,
    n.body,
    n.sender_public_id,
    n.amount,
    n.is_read,
    n.created_at
  from public.zono_notifications n
  where n.user_id = auth.uid()
    and n.created_at >= now() - interval '7 days'
    and (
      n.kind in ('seed_transfer','support','developer_message','company_message')
      OR (coalesce(n.amount,0) > 0 AND n.sender_public_id is not null)
    )
  order by n.id desc
  limit 100;
end;
$$;

grant execute on function public.zono_my_notifications() to authenticated;

-- Rebuild transfer function so every successful seed transfer
-- ALWAYS writes a receiver notification.
drop function if exists public.zono_transfer_seeds(bigint,bigint);

create function public.zono_transfer_seeds(
  p_recipient_public_id bigint,
  p_amount bigint
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_sender public.profiles%rowtype;
  v_recipient public.profiles%rowtype;
  v_notification_id bigint;
  v_sender_name text;
  v_sender_role text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'عدد البذور غير صحيح';
  end if;

  select * into v_sender
  from public.profiles
  where id = auth.uid()
  for update;

  if v_sender.id is null then
    raise exception 'ملف المرسل غير موجود';
  end if;

  if v_sender.role not in ('developer','agent') then
    raise exception 'إرسال البذور متاح للمطور والوكيل فقط';
  end if;

  select * into v_recipient
  from public.profiles
  where public_id = p_recipient_public_id
  for update;

  if v_recipient.id is null then
    raise exception 'ID المستلم غير موجود';
  end if;

  if v_recipient.id = v_sender.id then
    raise exception 'لا يمكن الإرسال إلى نفس الحساب';
  end if;

  if coalesce(v_sender.seeds,0) < p_amount then
    raise exception 'رصيد البذور غير كافٍ';
  end if;

  update public.profiles
  set seeds = coalesce(seeds,0) - p_amount
  where id = v_sender.id;

  update public.profiles
  set seeds = coalesce(seeds,0) + p_amount
  where id = v_recipient.id;

  v_sender_name := coalesce(nullif(v_sender.display_name,''),'مستخدم');
  v_sender_role := case
    when v_sender.role = 'developer' then 'المطور'
    when v_sender.role = 'agent' then 'الوكيل'
    else ''
  end;

  insert into public.zono_notifications(
    user_id,
    kind,
    title,
    body,
    sender_public_id,
    amount,
    is_read
  )
  values(
    v_recipient.id,
    'seed_transfer',
    'استلام بذور 🌾',
    'استلمت ' || p_amount || ' بذرة من ' ||
      v_sender_name || ' — ID ' ||
      coalesce(v_sender.public_id::text,'-') ||
      case when v_sender_role <> '' then ' — ' || v_sender_role else '' end,
    v_sender.public_id,
    p_amount,
    false
  )
  returning id into v_notification_id;

  return jsonb_build_object(
    'ok', true,
    'recipient_id', p_recipient_public_id,
    'amount', p_amount,
    'notification_id', v_notification_id
  );
end;
$$;

grant execute on function public.zono_transfer_seeds(bigint,bigint) to authenticated;

-- Individual notification read support.
drop function if exists public.zono_mark_notification_read(bigint);

create function public.zono_mark_notification_read(p_notification_id bigint)
returns void
language sql
security definer
set search_path=public
as $$
  update public.zono_notifications
  set is_read = true
  where id = p_notification_id
    and user_id = auth.uid();
$$;

grant execute on function public.zono_mark_notification_read(bigint) to authenticated;

notify pgrst,'reload schema';

-- Optional diagnostic after sending seeds:
-- select id,user_id,kind,title,body,sender_public_id,amount,is_read,created_at
-- from public.zono_notifications
-- order by id desc
-- limit 20;
