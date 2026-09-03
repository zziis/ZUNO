-- ZONO developer-only account ban control
-- Run once in Supabase SQL Editor.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS ban_reason text;

CREATE OR REPLACE FUNCTION public.zono_developer_ban_user(
    p_public_id bigint,
    p_duration text,
    p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role text;
    v_caller_public_id bigint;
    v_target_id uuid;
    v_until timestamptz;
    v_label text;
    v_reason text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED';
    END IF;

    SELECT role, public_id
      INTO v_caller_role, v_caller_public_id
      FROM public.profiles
     WHERE id = auth.uid();

    IF COALESCE(v_caller_role, '') <> 'developer' THEN
        RAISE EXCEPTION 'DEVELOPER_ONLY';
    END IF;

    IF p_public_id IS NULL OR p_public_id < 1 THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    IF p_public_id = v_caller_public_id THEN
        RAISE EXCEPTION 'CANNOT_BAN_SELF';
    END IF;

    v_reason := btrim(COALESCE(p_reason, ''));
    IF char_length(v_reason) < 3 THEN
        RAISE EXCEPTION 'REASON_REQUIRED';
    END IF;
    IF char_length(v_reason) > 300 THEN
        v_reason := left(v_reason, 300);
    END IF;

    CASE lower(COALESCE(p_duration, ''))
        WHEN 'hour' THEN
            v_until := now() + interval '1 hour';
            v_label := 'ساعة';
        WHEN 'day' THEN
            v_until := now() + interval '1 day';
            v_label := 'يوم';
        WHEN 'month' THEN
            v_until := now() + interval '1 month';
            v_label := 'شهر';
        WHEN 'year' THEN
            v_until := now() + interval '1 year';
            v_label := 'سنة';
        ELSE
            RAISE EXCEPTION 'INVALID_DURATION';
    END CASE;

    SELECT id INTO v_target_id
      FROM public.profiles
     WHERE public_id = p_public_id;

    IF v_target_id IS NULL THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    UPDATE public.profiles
       SET is_banned = true,
           banned_until = v_until,
           ban_reason = v_reason
     WHERE id = v_target_id;

    RETURN jsonb_build_object(
        'ok', true,
        'public_id', p_public_id,
        'banned_until', v_until,
        'duration', lower(p_duration),
        'duration_label', v_label,
        'reason', v_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION public.zono_developer_ban_user(bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zono_developer_ban_user(bigint,text,text) TO authenticated;
