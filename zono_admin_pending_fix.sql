
-- ZONO: إصلاح ظهور طلبات السحب في قسم حوالات المطور
-- يستخدم دوال V3 ترجع صفوفاً مباشرة بدلاً من JSON scalar.

CREATE OR REPLACE FUNCTION public.zono_withdrawal_pending_v3()
RETURNS TABLE (
    id bigint,
    public_id bigint,
    display_name text,
    method text,
    account_name text,
    fib_phone text,
    qi_phone_11 text,
    qi_account text,
    amount_seeds bigint,
    amount_iqd bigint,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    PERFORM public.zono__require_developer_v2();

    RETURN QUERY
    SELECT
        r.id,
        r.public_id_snapshot,
        r.display_name_snapshot,
        r.method,
        r.account_name,
        r.fib_phone,
        r.qi_phone_11,
        r.qi_account,
        r.amount_seeds,
        r.amount_iqd,
        r.created_at
    FROM public.zono_withdrawal_requests_v2 r
    WHERE lower(btrim(r.status)) = 'pending'
    ORDER BY r.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.zono_withdrawal_approved_v3()
RETURNS TABLE (
    id bigint,
    public_id bigint,
    display_name text,
    account_name text,
    amount_seeds bigint,
    amount_iqd bigint,
    method text,
    reviewed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    PERFORM public.zono__require_developer_v2();

    RETURN QUERY
    SELECT
        r.id,
        r.public_id_snapshot,
        r.display_name_snapshot,
        r.account_name,
        r.amount_seeds,
        r.amount_iqd,
        r.method,
        r.reviewed_at
    FROM public.zono_withdrawal_requests_v2 r
    WHERE lower(btrim(r.status)) = 'approved'
    ORDER BY r.reviewed_at DESC NULLS LAST
    LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.zono_withdrawal_pending_v3() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.zono_withdrawal_approved_v3() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.zono_withdrawal_pending_v3() TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_withdrawal_approved_v3() TO authenticated;

NOTIFY pgrst, 'reload schema';
SELECT pg_notify('pgrst','reload schema');

-- فحص الطلبات الموجودة فعلياً حالياً
SELECT
    id,
    public_id_snapshot,
    display_name_snapshot,
    method,
    amount_seeds,
    status,
    created_at
FROM public.zono_withdrawal_requests_v2
ORDER BY created_at DESC
LIMIT 50;
