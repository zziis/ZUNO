class ZunoAuth {
  constructor() {
    this.user = null;
    this.profile = null;
    this.client = window.zunoBackend?.client || null;
  }

  async init() {
    if (!this.client) return false;
    const { data } = await this.client.auth.getSession();
    if (data?.session?.user) await this.loadProfile(data.session.user);
    this.client.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        await this.loadProfile(session.user);
        window.zunoApp?.enterApp();
      } else {
        this.user = null; this.profile = null;
        window.zunoApp?.showAuth();
      }
    });
    return !!this.user;
  }

  async loadProfile(user) {
    this.user = user;
    const { data, error } = await this.client.from('profiles').select('*').eq('id', user.id).single();
    if (error) throw new Error('تعذر تحميل بيانات الحساب');
    this.profile = data;
    return data;
  }

  async login(identifier, password) {
    if (!this.client) throw new Error('Supabase غير مربوط بعد');
    identifier = String(identifier || '').trim();
    if (!identifier || !password) throw new Error('أدخل ID أو البريد وكلمة المرور');

    let session;
    if (identifier.includes('@')) {
      const { data, error } = await this.client.auth.signInWithPassword({ email: identifier.toLowerCase(), password });
      if (error) throw new Error('البريد أو كلمة المرور غير صحيحة');
      session = data.session;
    } else {
      const id = Number(identifier.replace(/\D/g,''));
      if (!Number.isInteger(id) || id < 1) throw new Error('ID غير صحيح');
      const { data, error } = await this.client.functions.invoke('auth-login', { body: { public_id: id, password } });
      if (error || !data?.access_token || !data?.refresh_token) throw new Error(data?.error || 'ID أو كلمة المرور غير صحيحة');
      const { data: s, error: e } = await this.client.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      if (e) throw new Error('تعذر فتح جلسة الحساب');
      session = s.session;
    }
    await this.loadProfile(session.user);
    return this.profile;
  }

  async register({name,email,password,confirm,invite}) {
    if (!this.client) throw new Error('Supabase غير مربوط بعد');
    if (!name?.trim() || !email?.trim() || !password || !confirm) throw new Error('أكمل الحقول المطلوبة');
    if (password !== confirm) throw new Error('كلمتا المرور غير متطابقتين');
    if (password.length < 6) throw new Error('كلمة المرور 6 أحرف على الأقل');
    let inviteId = null;
    if (String(invite || '').trim()) {
      inviteId = Number(String(invite).replace(/\D/g,''));
      if (!Number.isInteger(inviteId) || inviteId < 1) throw new Error('ID الدعوة غير صحيح');
      const { data, error } = await this.client.rpc('zuno_invite_exists', { p_invite_id: inviteId });
      if (error || !data) throw new Error('ID الدعوة غير موجود');
    }
    const { data, error } = await this.client.auth.signUp({
      email: email.trim().toLowerCase(), password,
      options: { data: { display_name: name.trim(), invite_id: inviteId } }
    });
    if (error) throw new Error(this.friendly(error.message));
    if (data?.session?.user) await this.loadProfile(data.session.user);
    return data;
  }

  async logout() {
    if (this.client) await this.client.auth.signOut();
  }

  friendly(msg='') {
    const m = msg.toLowerCase();
    if (m.includes('already')) return 'البريد مستخدم بالفعل';
    if (m.includes('password')) return 'كلمة المرور غير مقبولة';
    return msg || 'حدث خطأ في الحساب';
  }
}
window.zunoAuth = new ZunoAuth();
