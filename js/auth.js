class ZonoAuth {
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
        if (window.zunoApp) {
          await window.zunoApp.syncUserFromSupabase();
          window.zunoApp.showMainApp();
        }
      } else {
        this.user = null; this.profile = null;
        window.zunoApp?.showAuthModal();
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
      const normalizedEmail = identifier.toLowerCase().trim();
      const { data, error } = await this.client.auth.signInWithPassword({
        email: normalizedEmail,
        password
      });

      if (error) {
        const raw = String(error.message || '').toLowerCase();

        if (raw.includes('email not confirmed')) {
          throw new Error('البريد الإلكتروني غير مؤكد. افتح رسالة التأكيد ثم حاول مرة أخرى.');
        }

        if (raw.includes('invalid login credentials')) {
          throw new Error('بيانات الدخول غير صحيحة. تأكد من البريد وكلمة المرور كما كُتبت عند إنشاء الحساب.');
        }

        if (raw.includes('user not found')) {
          throw new Error('لا يوجد حساب بهذا البريد الإلكتروني.');
        }

        if (raw.includes('network') || raw.includes('fetch')) {
          throw new Error('تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.');
        }

        throw new Error(error.message || 'تعذر تسجيل الدخول');
      }

      if (!data?.session?.user) {
        throw new Error('لم يتم إنشاء جلسة تسجيل الدخول. حاول مرة أخرى.');
      }

      session = data.session;
    } else {
      const id = Number(identifier.replace(/\D/g,''));
      if (!Number.isInteger(id) || id < 1) throw new Error('ID غير صحيح');
      const { data, error } = await this.client.functions.invoke('login-by-id', {
        body: { public_id: id, password }
      });

      // الدالة الجديدة ترجع التوكنات داخل session، مع دعم الشكل القديم احتياطياً.
      const accessToken = data?.session?.access_token || data?.access_token;
      const refreshToken = data?.session?.refresh_token || data?.refresh_token;

      if (error || !accessToken || !refreshToken) {
        throw new Error(data?.error || 'ID أو كلمة المرور غير صحيحة');
      }

      const { data: s, error: e } = await this.client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });

      if (e || !s?.session?.user) throw new Error('تعذر فتح جلسة الحساب');
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

  async updateDisplayName(name) {
    if (!this.client || !this.user) throw new Error('يجب تسجيل الدخول');
    const value = String(name || '').trim();
    if (value.length < 2 || value.length > 40) throw new Error('الاسم من 2 إلى 40 حرفاً');
    const { error } = await this.client.rpc('zuno_update_display_name', { p_name: value });
    if (error) throw new Error(error.message || 'تعذر تغيير الاسم');
    await this.loadProfile(this.user);
    return this.profile;
  }

  async featherInventory() {
    if (!this.client || !this.user) return [];
    const { data, error } = await this.client.rpc('zono_bird_inventory');
    if (error) return [];
    return Array.isArray(data) ? data.map(x => x.item_id) : [];
  }


  friendly(msg='') {
    const m = msg.toLowerCase();
    if (m.includes('already')) return 'البريد مستخدم بالفعل';
    if (m.includes('password')) return 'كلمة المرور غير مقبولة';
    return msg || 'حدث خطأ في الحساب';
  }
}
window.zonoAuth = new ZonoAuth();
