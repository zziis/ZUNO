-- ZONO: المطور + الوكيل + تحويل البذور + الإشعارات + دورة المطور 3 دقائق
-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor.

alter table public.profiles add column if not exists seeds bigint not null default 0 check (seeds >= 0);
alter table public.profiles add column if not exists developer_seed_last_claim timestamptz;

-- السماح بالأدوار المطلوبة (إذا كان لديك constraint قديم على role عدّله يدوياً ليشمل agent)

create table if not exists public.seed_transfers (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'seed_received',
  sender_id uuid references public.profiles(id) on delete set null,
  amount bigint not null default 0,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.seed_transfers enable row level security;
alter table public.notifications enable row level security;
revoke insert,update,delete on public.seed_transfers from anon,authenticated;
revoke insert,update,delete on public.notifications from anon,authenticated;

-- المطور/الوكيل يرسل بذور لأي مستخدم. العملية ذرّية وآمنة داخل قاعدة البيانات.
create or replace function public.zono_transfer_seeds(p_target_public_id bigint, p_amount bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_sender public.profiles%rowtype;
  v_receiver public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'عدد البذور غير صحيح'; end if;

  select * into v_sender from public.profiles where id=auth.uid() for update;
  if v_sender.role not in ('developer','agent') then raise exception 'الإرسال متاح للمطور والوكيل فقط'; end if;
  if coalesce(v_sender.seeds,0) < p_amount then raise exception 'رصيد البذور غير كافٍ'; end if;

  select * into v_receiver from public.profiles where public_id=p_target_public_id for update;
  if v_receiver.id is null then raise exception 'لم يتم العثور على المستخدم'; end if;
  if v_receiver.id=v_sender.id then raise exception 'لا يمكن التحويل إلى نفس الحساب'; end if;

  update public.profiles set seeds=seeds-p_amount where id=v_sender.id;
  update public.profiles set seeds=seeds+p_amount where id=v_receiver.id;
  insert into public.seed_transfers(sender_id,receiver_id,amount) values(v_sender.id,v_receiver.id,p_amount);
  insert into public.notifications(user_id,kind,sender_id,amount) values(v_receiver.id,'seed_received',v_sender.id,p_amount);

  return jsonb_build_object('ok',true,'amount',p_amount,'receiver_public_id',v_receiver.public_id,'balance',v_sender.seeds-p_amount);
end $$;

-- إشعارات المستخدم، وفيها اسم + ID + صفة المرسل.
create or replace function public.zono_my_notifications()
returns table(id bigint,kind text,amount bigint,is_read boolean,created_at timestamptz,sender_name text,sender_public_id bigint,sender_role text)
language sql security definer set search_path=public as $$
  select n.id,n.kind,n.amount,n.is_read,n.created_at,
         coalesce(p.display_name,'مستخدم زونو')::text,p.public_id::bigint,p.role::text
  from public.notifications n left join public.profiles p on p.id=n.sender_id
  where n.user_id=auth.uid()
  order by n.created_at desc limit 50;
$$;

create or replace function public.zono_mark_notifications_read()
returns void language sql security definer set search_path=public as $$
  update public.notifications set is_read=true where user_id=auth.uid() and is_read=false;
$$;

-- إنتاج المطور كل 3 دقائق فقط. كمية الإنتاج تعتمد على شكل العصفور الحالي.
create or replace function public.zono_developer_claim_seeds()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_role text; v_last timestamptz; v_bird text; v_reward bigint; v_balance bigint;
begin
  if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
  select role,developer_seed_last_claim,active_bird,seeds into v_role,v_last,v_bird,v_balance
  from public.profiles where id=auth.uid() for update;
  if v_role <> 'developer' then raise exception 'هذه المكافأة للمطور فقط'; end if;
  if v_last is not null and v_last > now()-interval '3 minutes' then raise exception 'لم تكتمل 3 دقائق بعد'; end if;
  v_reward := case v_bird when 'classic_gold' then 500 when 'emerald' then 750 when 'royal_blue' then 1000 when 'crimson_phoenix' then 1500 else 500 end;
  update public.profiles set seeds=seeds+v_reward,developer_seed_last_claim=now() where id=auth.uid() returning seeds into v_balance;
  return jsonb_build_object('ok',true,'reward',v_reward,'seeds',v_balance);
end $$;

grant execute on function public.zono_transfer_seeds(bigint,bigint) to authenticated;
grant execute on function public.zono_my_notifications() to authenticated;
grant execute on function public.zono_mark_notifications_read() to authenticated;
grant execute on function public.zono_developer_claim_seeds() to authenticated;

-- مثال لترقية حساب إلى وكيل بعد معرفة ID الخاص به:
-- update public.profiles set role='agent' where public_id=1000;

notify pgrst,'reload schema';
