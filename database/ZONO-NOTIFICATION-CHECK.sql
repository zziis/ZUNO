-- تحقق من أن إشعارات البذور تُسجل
-- غيّر 1003 إلى ID المستخدم الذي استلم البذور.

select
  p.public_id,
  p.display_name,
  n.id,
  n.kind,
  n.title,
  n.body,
  n.amount,
  n.is_read,
  n.created_at
from public.zono_notifications n
join public.profiles p on p.id = n.user_id
where p.public_id = 1003
order by n.created_at desc
limit 20;

-- تحديث PostgREST بعد أي تغييرات
notify pgrst, 'reload schema';
