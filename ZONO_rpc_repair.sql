
-- ZONO RPC REPAIR PATCH
-- يصلح دوال: إنشاء/فتح رمز الاستعلام + حظر + إلغاء الحظر
-- نفّذ الملف كاملاً مرة واحدة في Supabase SQL Editor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- الحقول المطلوبة للحظر / إلغاء الحظر
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ban_reason text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_unban_note text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_unbanned_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_unbanned_by uuid;

-- جداول قفل استعلام المطور
CREATE TABLE IF NOT EXISTS public.zono_developer_console_lock (
    developer_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    pin_hash text NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0,
    locked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.zono_developer_console_sessions (
    token_hash text PRIMARY KEY,
    developer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.zono_developer_console_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zono_developer_console_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.zono_developer_console_lock FROM anon, authenticated;
REVOKE ALL ON public.zono_developer_console_sessions FROM anon, authenticated;

-- تحقق أن المستدعي هو المطور
CREATE OR REPLACE FUNCTION public.zono__require_developer()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_role text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED';
    END IF;

    SELECT role INTO v_role
    FROM public.profiles
    WHERE id = auth.uid();

    IF COALESCE(v_role, '') <> 'developer' THEN
        RAISE EXCEPTION 'DEVELOPER_ONLY';
    END IF;
END;
$$;

-- حالة القفل
CREATE OR REPLACE FUNCTION public.zono_developer_console_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_configured boolean := false;
    v_locked_until timestamptz;
BEGIN
    PERFORM public.zono__require_developer();

    SELECT true, locked_until
    INTO v_configured, v_locked_until
    FROM public.zono_developer_console_lock
    WHERE developer_id = auth.uid();

    RETURN jsonb_build_object(
        'configured', COALESCE(v_configured, false),
        'locked', (v_locked_until IS NOT NULL AND v_locked_until > now()),
        'locked_until', v_locked_until
    );
END;
$$;

-- إنشاء رمز لأول مرة
CREATE OR REPLACE FUNCTION public.zono_developer_console_set_pin(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_pin text := COALESCE(p_pin,'');
BEGIN
    PERFORM public.zono__require_developer();

    IF char_length(v_pin) < 6 OR char_length(v_pin) > 32 THEN
        RAISE EXCEPTION 'INVALID_PIN_LENGTH';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.zono_developer_console_lock
        WHERE developer_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'PIN_ALREADY_CONFIGURED';
    END IF;

    INSERT INTO public.zono_developer_console_lock(developer_id, pin_hash)
    VALUES (auth.uid(), crypt(v_pin, gen_salt('bf', 10)));

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- فتح القفل
CREATE OR REPLACE FUNCTION public.zono_developer_console_unlock(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_row public.zono_developer_console_lock%ROWTYPE;
    v_token text;
    v_token_hash text;
    v_expires timestamptz := now() + interval '10 minutes';
    v_failures integer;
BEGIN
    PERFORM public.zono__require_developer();

    SELECT *
    INTO v_row
    FROM public.zono_developer_console_lock
    WHERE developer_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PIN_NOT_CONFIGURED';
    END IF;

    IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
        RAISE EXCEPTION 'CONSOLE_LOCKED';
    END IF;

    IF crypt(COALESCE(p_pin,''), v_row.pin_hash) <> v_row.pin_hash THEN
        v_failures := COALESCE(v_row.failed_attempts,0) + 1;

        UPDATE public.zono_developer_console_lock
        SET failed_attempts = CASE WHEN v_failures >= 5 THEN 0 ELSE v_failures END,
            locked_until = CASE WHEN v_failures >= 5 THEN now() + interval '10 minutes' ELSE NULL END,
            updated_at = now()
        WHERE developer_id = auth.uid();

        IF v_failures >= 5 THEN
            RAISE EXCEPTION 'CONSOLE_LOCKED';
        END IF;

        RAISE EXCEPTION 'INVALID_PIN';
    END IF;

    UPDATE public.zono_developer_console_lock
    SET failed_attempts = 0,
        locked_until = NULL,
        updated_at = now()
    WHERE developer_id = auth.uid();

    DELETE FROM public.zono_developer_console_sessions
    WHERE developer_id = auth.uid() OR expires_at <= now();

    v_token := encode(gen_random_bytes(32), 'hex');
    v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

    INSERT INTO public.zono_developer_console_sessions(token_hash, developer_id, expires_at)
    VALUES (v_token_hash, auth.uid(), v_expires);

    RETURN jsonb_build_object(
        'ok', true,
        'token', v_token,
        'expires_at', v_expires
    );
END;
$$;

-- حظر مستخدم: نفس أسماء الباراميترات التي يستدعيها app.js
CREATE OR REPLACE FUNCTION public.zono_developer_ban_user(
    p_public_id bigint,
    p_duration text,
    p_reason text,
    p_custom_amount integer DEFAULT NULL,
    p_custom_unit text DEFAULT NULL
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
    v_amount integer;
    v_unit text;
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
        WHEN 'day' THEN
            v_until := now() + interval '1 day';
            v_label := 'يوم';
        WHEN 'month' THEN
            v_until := now() + interval '1 month';
            v_label := 'شهر';
        WHEN 'year' THEN
            v_until := now() + interval '1 year';
            v_label := 'سنة';
        WHEN 'custom' THEN
            v_amount := COALESCE(p_custom_amount, 0);
            v_unit := lower(COALESCE(p_custom_unit, ''));

            IF v_amount < 1 OR v_amount > 9999 THEN
                RAISE EXCEPTION 'INVALID_CUSTOM_DURATION';
            END IF;

            CASE v_unit
                WHEN 'minute' THEN
                    v_until := now() + (v_amount * interval '1 minute');
                    v_label := v_amount || ' دقيقة';
                WHEN 'hour' THEN
                    v_until := now() + (v_amount * interval '1 hour');
                    v_label := v_amount || ' ساعة';
                WHEN 'day' THEN
                    v_until := now() + (v_amount * interval '1 day');
                    v_label := v_amount || ' يوم';
                WHEN 'month' THEN
                    v_until := now() + (v_amount * interval '1 month');
                    v_label := v_amount || ' شهر';
                WHEN 'year' THEN
                    v_until := now() + (v_amount * interval '1 year');
                    v_label := v_amount || ' سنة';
                ELSE
                    RAISE EXCEPTION 'INVALID_CUSTOM_DURATION';
            END CASE;
        ELSE
            RAISE EXCEPTION 'INVALID_DURATION';
    END CASE;

    SELECT id
    INTO v_target_id
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

-- إلغاء الحظر
CREATE OR REPLACE FUNCTION public.zono_developer_unban_user(
    p_public_id bigint,
    p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_role text;
    v_target_id uuid;
    v_note text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED';
    END IF;

    SELECT role
    INTO v_caller_role
    FROM public.profiles
    WHERE id = auth.uid();

    IF COALESCE(v_caller_role, '') <> 'developer' THEN
        RAISE EXCEPTION 'DEVELOPER_ONLY';
    END IF;

    SELECT id
    INTO v_target_id
    FROM public.profiles
    WHERE public_id = p_public_id;

    IF v_target_id IS NULL THEN
        RAISE EXCEPTION 'USER_NOT_FOUND';
    END IF;

    v_note := NULLIF(btrim(COALESCE(p_note, '')), '');

    IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN
        v_note := left(v_note, 300);
    END IF;

    UPDATE public.profiles
    SET is_banned = false,
        banned_until = NULL,
        ban_reason = NULL,
        last_unban_note = v_note,
        last_unbanned_at = now(),
        last_unbanned_by = auth.uid()
    WHERE id = v_target_id;

    RETURN jsonb_build_object(
        'ok', true,
        'public_id', p_public_id,
        'note', v_note,
        'unbanned_at', now()
    );
END;
$$;

-- الصلاحيات الدقيقة للدوال التي تستدعيها الواجهة
REVOKE ALL ON FUNCTION public.zono_developer_console_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.zono_developer_console_set_pin(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.zono_developer_console_unlock(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.zono_developer_ban_user(bigint,text,text,integer,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.zono_developer_unban_user(bigint,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.zono_developer_console_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_developer_console_set_pin(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_developer_console_unlock(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_developer_ban_user(bigint,text,text,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_developer_unban_user(bigint,text) TO authenticated;

-- اجبار PostgREST على إعادة قراءة الدوال
NOTIFY pgrst, 'reload schema';
SELECT pg_notify('pgrst', 'reload schema');

-- فحص أخير: يجب أن تظهر الدوال الخمسة وأسماء باراميتراتها
SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'zono_developer_console_status',
      'zono_developer_console_set_pin',
      'zono_developer_console_unlock',
      'zono_developer_ban_user',
      'zono_developer_unban_user'
  )
ORDER BY p.proname;
