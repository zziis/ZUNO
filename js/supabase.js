(() => {
  const cfg = window.ZUNO_CONFIG || {};
  const valid = /^https:\/\/.+\.supabase\.co$/.test(cfg.SUPABASE_URL || '') &&
    cfg.SUPABASE_ANON_KEY && !String(cfg.SUPABASE_ANON_KEY).includes('PASTE_');

  window.zunoBackend = {
    configured: !!valid,
    client: valid && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    }) : null
  };
})();
