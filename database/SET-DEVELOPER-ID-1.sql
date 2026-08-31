-- بعد إنشاء حسابك من واجهة Zuno أو من Supabase Auth، ضع بريدك هنا ثم شغّل الملف مرة واحدة.
do $$
declare
  v_email text := 'YOUR-DEVELOPER-EMAIL@example.com';
  v_uid uuid;
  v_name text;
begin
  select id,coalesce(raw_user_meta_data->>'display_name',split_part(email,'@',1)) into v_uid,v_name
  from auth.users where lower(email)=lower(v_email) limit 1;
  if v_uid is null then raise exception 'لم يتم العثور على حساب المطور بهذا البريد: %',v_email;end if;

  -- إذا كان ID 1 مستخدماً بطريق الخطأ، ننقله إلى رقم عادي جديد.
  update public.profiles set public_id=nextval('public.zuno_public_id_seq') where public_id=1 and id<>v_uid;

  insert into public.profiles(id,public_id,display_name,role)
  values(v_uid,1,coalesce(v_name,'Zuno Developer'),'developer')
  on conflict(id) do update set public_id=1,role='developer',updated_at=now();

  raise notice 'تم تثبيت حساب المطور على ID 1. سجّل الدخول بالرقم 1 وكلمة مرور نفس الحساب.';
end $$;
notify pgrst,'reload schema';
