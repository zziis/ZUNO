-- ZONO ACCOUNT VERIFICATION + WITHDRAWAL VALIDATION
-- Run once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.zono_account_verification(
 user_id uuid primary key references public.profiles(id) on delete cascade,
 full_name text not null,birth_date date not null,phone text not null,
 verification_code_hash text not null,created_at timestamptz not null default now()
);
alter table public.zono_account_verification enable row level security;
revoke all on public.zono_account_verification from anon,authenticated;

create or replace function public.zono_verification_status() returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('verified',exists(select 1 from public.zono_account_verification where user_id=auth.uid()));
$$;
grant execute on function public.zono_verification_status() to authenticated;

create or replace function public.zono_create_account_verification(p_full_name text,p_birth_date date,p_phone text,p_verification_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
 if exists(select 1 from public.zono_account_verification where user_id=auth.uid()) then raise exception 'تم إنشاء وثيقة التوثيق مسبقاً ولا يمكن إنشاؤها مرة أخرى'; end if;
 if length(trim(coalesce(p_full_name,'')))<3 then raise exception 'الاسم الكامل غير صحيح'; end if;
 if p_birth_date is null or p_birth_date>=current_date then raise exception 'تاريخ الميلاد غير صحيح'; end if;
 if coalesce(p_phone,'') !~ '^[0-9]{10,15}$' then raise exception 'رقم الهاتف غير صحيح'; end if;
 if coalesce(p_verification_code,'') !~ '^[0-9]{4,8}$' then raise exception 'رمز التوثيق يجب أن يكون من 4 إلى 8 أرقام'; end if;
 insert into public.zono_account_verification values(auth.uid(),trim(p_full_name),p_birth_date,p_phone,crypt(p_verification_code,gen_salt('bf')),now());
 return jsonb_build_object('ok',true,'verified',true);
end $$;
grant execute on function public.zono_create_account_verification(text,date,text,text) to authenticated;

create or replace function public.zono_unlock_account_verification(p_verification_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.zono_account_verification%rowtype;
begin
 select * into v from public.zono_account_verification where user_id=auth.uid();
 if v.user_id is null then raise exception 'الحساب غير موثق'; end if;
 if crypt(p_verification_code,v.verification_code_hash)<>v.verification_code_hash then raise exception 'رمز التوثيق غير صحيح'; end if;
 return jsonb_build_object('ok',true,'full_name',v.full_name,'birth_date',v.birth_date,'phone',v.phone);
end $$;
grant execute on function public.zono_unlock_account_verification(text) to authenticated;

alter table public.zono_withdrawals alter column verification_code drop not null;
update public.zono_withdrawals set verification_code=null where verification_code is not null;

create or replace function public.zono_create_withdrawal(p_method text,p_account_name text,p_fib_phone text,p_qi_phone_11 text,p_qi_account text,p_amount_seeds bigint,p_verification_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_profile public.profiles%rowtype; v_verify public.zono_account_verification%rowtype; v_id bigint;
begin
 if auth.uid() is null then raise exception 'يجب تسجيل الدخول'; end if;
 select * into v_verify from public.zono_account_verification where user_id=auth.uid();
 if v_verify.user_id is null then raise exception 'يجب توثيق الحساب أولاً قبل سحب البذور'; end if;
 if crypt(coalesce(p_verification_code,''),v_verify.verification_code_hash)<>v_verify.verification_code_hash then raise exception 'رمز توثيق الحساب غير صحيح'; end if;
 if p_method not in ('fib','qi') then raise exception 'طريقة السحب غير صحيحة'; end if;
 if length(trim(coalesce(p_account_name,'')))<2 then raise exception 'اسم صاحب الحساب مطلوب'; end if;
 if p_amount_seeds is null or p_amount_seeds<15000 then raise exception 'الحد الأدنى للسحب 15000 بذرة'; end if;
 if p_method='fib' and coalesce(p_fib_phone,'') !~ '^[0-9]{10,15}$' then raise exception 'رقم هاتف FIB غير صحيح'; end if;
 if p_method='qi' and coalesce(p_qi_phone_11,'') !~ '^[0-9]{11}$' then raise exception 'يجب أن يكون رقم Qi مكوناً من 11 رقم'; end if;
 if p_method='qi' and coalesce(p_qi_account,'') !~ '^[0-9]{4,30}$' then raise exception 'رقم حساب Qi غير صحيح'; end if;
 select * into v_profile from public.profiles where id=auth.uid() for update;
 if coalesce(v_profile.seeds,0)<p_amount_seeds then raise exception 'رصيد البذور غير كافٍ'; end if;
 update public.profiles set seeds=coalesce(seeds,0)-p_amount_seeds where id=v_profile.id;
 insert into public.zono_withdrawals(user_id,public_id,method,account_name,fib_phone,qi_phone_11,qi_account,amount_seeds,amount_iqd,verification_code,status)
 values(v_profile.id,v_profile.public_id,p_method,trim(p_account_name),case when p_method='fib' then p_fib_phone end,case when p_method='qi' then p_qi_phone_11 end,case when p_method='qi' then p_qi_account end,p_amount_seeds,p_amount_seeds,null,'pending') returning id into v_id;
 return jsonb_build_object('ok',true,'id',v_id,'status','pending','amount_seeds',p_amount_seeds,'amount_iqd',p_amount_seeds);
end $$;
grant execute on function public.zono_create_withdrawal(text,text,text,text,text,bigint,text) to authenticated;
notify pgrst,'reload schema';
