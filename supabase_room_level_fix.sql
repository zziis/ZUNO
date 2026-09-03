-- ZONO Room Level final fix
-- شغّل هذا الملف مرة واحدة داخل Supabase > SQL Editor

ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS room_level integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.zono_get_room_level(p_room_public_id bigint)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(r.room_level, 1)::integer
    FROM public.rooms r
    WHERE r.public_id = p_room_public_id
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.zono_get_room_level(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zono_get_room_level(bigint) TO anon;

-- مثال رفع روم ID 50 إلى LV.100:
-- UPDATE public.rooms SET room_level = 100 WHERE public_id = 50;
