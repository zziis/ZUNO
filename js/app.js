class ZonoApp {
    constructor() {
        this.currentUser = null;
        this.currentTab = 'rooms';
        this.activeRoom = null;
        this.activeDirectChat = null;
        this.birdEngine = null;
        this.theme = localStorage.getItem('zono_theme') || 'dark';
        this.soundEnabled = localStorage.getItem('zono_sound') !== 'false';
        this.init();
    }

    async init() {
        this.applyTheme(this.theme);
        this.bindEvents();
        this.renderRooms();
        this.renderDirectChats();
        this.renderNews();

        if (window.zonoAudio) window.zonoAudio.enabled = this.soundEnabled;

        try {
            const logged = await window.zonoAuth.init();
            if (logged) {
                await this.syncUserFromSupabase();
                this.showMainApp();
            } else {
                this.showAuthModal();
            }
        } catch (e) {
            this.showAuthModal();
            this.setAuthMessage(e.message || 'تعذر تهيئة الحساب', 'error');
        }

        setTimeout(() => {
            if (document.getElementById('bird-canvas')) {
                this.birdEngine = new ZonoBirdEngine('bird-canvas');
                window.zonoBirdEngine = this.birdEngine;
                if (this.currentUser?.activeBird) this.birdEngine.setSkin(this.currentUser.activeBird);
                this.renderStore();
            }
        }, 120);
    }

    async syncUserFromSupabase() {
        const p = window.zonoAuth?.profile;
        const u = window.zonoAuth?.user;
        if (!p || !u) return;

        const inventory = await window.zonoAuth.featherInventory();

        // Bird economy summary: repeated purchases + total daily income.
        let birdPurchaseCounts = {};
        let dailySeedsTotal = 0;
        let dailyFeathersTotal = 60;

        try {
            const client = window.zonoBackend?.client || window.zonoAuth?.client;
            if (client) {
                const [{ data: totalsData }, { data: countsData }] = await Promise.all([
                    client.rpc('zono_bird_daily_totals'),
                    client.rpc('zono_bird_purchase_counts')
                ]);

                if (totalsData) {
                    dailySeedsTotal = Number(totalsData.seeds_daily || 0);
                    dailyFeathersTotal = Number(totalsData.feathers_daily || 60);
                }

                if (Array.isArray(countsData)) {
                    countsData.forEach(row => {
                        birdPurchaseCounts[row.item_id] = Number(row.purchase_count || 0);
                    });
                }
            }
        } catch (_) {
            // Keeps the app usable before/while the SQL migration is being applied.
        }

        const joined = p.created_at ? new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium'}).format(new Date(p.created_at)) : '—';

        this.currentUser = {
            id: u.id,
            username: String(p.public_id || ''),
            displayName: p.display_name || 'عضو Zono',
            isGuest: false,
            avatar: p.avatar_url || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(p.public_id || u.id)}`,
            feathers: Number(p.feathers || 0),
            seeds: Number(p.seeds || 0),
            activeBirdRank: Number(p.active_bird_rank || 0),
            birdPlanEndsAt: p.bird_plan_ends_at || null,
            birdPurchaseCounts,
            dailySeedsTotal,
            dailyFeathersTotal,
            bio: p.bio || 'عضو في مجتمع Zono 🕊️',
            badge: p.role === 'developer' ? 'المطور 👑' : 'عضو Zono 🕊️',
            frame: 'vintage-avatar-frame',
            joinedDate: joined,
            activeBird: p.active_bird || 'classic_gold',
            stats: {
                flightHours: 0,
                roomsCreated: 0,
                messagesSent: 0,
                feathersEarned: Number(p.feathers || 0)
            },
            inventory: Array.from(new Set(['classic_gold', ...inventory]))
        };

        this.updateHeaderUI();
        this.updateProfileUI();
        this.renderStore();
    }

    saveUser() {
        // الحساب والريش محفوظان في Supabase. هنا نحدّث الواجهة فقط.
        this.updateHeaderUI();
        this.updateProfileUI();
    }

    applyTheme(theme) {
        this.theme = theme;
        if (theme === 'parchment') {
            document.documentElement.setAttribute('data-theme', 'parchment');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        localStorage.setItem('zono_theme', theme);
        const toggleBtn = document.getElementById('theme-toggle-btn');
        if (toggleBtn) {
            toggleBtn.innerHTML = theme === 'parchment' ? '🌙' : '📜';
        }
    }

    toggleTheme() {
        this.applyTheme(this.theme === 'parchment' ? 'dark' : 'parchment');
        if (window.zonoAudio) window.zonoAudio.playTap();
        this.showToast(`تم التبديل إلى ${this.theme === 'parchment' ? 'وضع الورق العاجي 📜' : 'وضع فخامة الليل 🌙'}`);
    }

    toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        localStorage.setItem('zono_sound', this.soundEnabled.toString());
        if (window.zonoAudio) window.zonoAudio.enabled = this.soundEnabled;
        this.showToast(this.soundEnabled ? 'تم تفعيل الأصوات 🔔' : 'تم كتم الأصوات 🔕');
        const soundEl = document.getElementById('setting-sound-toggle');
        if (soundEl) soundEl.checked = this.soundEnabled;
    }

    showAuthModal() {
        const authModal = document.getElementById('auth-modal');
        if (authModal) authModal.classList.remove('hidden');
    }

    hideAuthModal() {
        const authModal = document.getElementById('auth-modal');
        if (authModal) authModal.classList.add('hidden');
    }

    showMainApp() {
        this.hideAuthModal();
        this.updateHeaderUI();
        this.updateProfileUI();
        this.renderStore();
    }

    authTab(mode) {
        const login = mode === 'login';
        document.getElementById('zono-login-form')?.classList.toggle('hidden', !login);
        document.getElementById('zono-register-form')?.classList.toggle('hidden', login);
        document.getElementById('auth-tab-login')?.classList.toggle('active', login);
        document.getElementById('auth-tab-register')?.classList.toggle('active', !login);
        this.setAuthMessage('');
    }

    togglePassword(id, button) {
        const input = document.getElementById(id);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        if (button) button.textContent = input.type === 'password' ? '👁' : '🙈';
    }

    setAuthMessage(message='', type='') {
        const el = document.getElementById('auth-message');
        if (!el) return;
        el.textContent = message;
        el.className = `min-h-[22px] mt-4 text-center text-xs font-bold ${type || ''}`;
    }

    async handleLogin(event) {
        event.preventDefault();
        const btn = document.getElementById('auth-login-btn');
        if (btn) btn.disabled = true;
        this.setAuthMessage('');
        try {
            await window.zonoAuth.login(
                document.getElementById('auth-login-id').value,
                document.getElementById('auth-login-pass').value
            );
            await this.syncUserFromSupabase();
            this.showMainApp();
            if (window.zonoAudio) window.zonoAudio.playChirp();
            this.showToast(`مرحباً بك يا ${this.currentUser.displayName}!`, 'success');
        } catch (e) {
            this.setAuthMessage(e.message || 'تعذر تسجيل الدخول', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async handleRegister(event) {
        event.preventDefault();
        const btn = document.getElementById('auth-register-btn');
        if (btn) btn.disabled = true;
        this.setAuthMessage('');
        try {
            const data = await window.zonoAuth.register({
                name: document.getElementById('auth-reg-name').value,
                email: document.getElementById('auth-reg-email').value,
                password: document.getElementById('auth-reg-pass').value,
                confirm: document.getElementById('auth-reg-confirm').value,
                invite: document.getElementById('auth-reg-invite').value
            });

            if (data?.session) {
                await this.syncUserFromSupabase();
                this.showMainApp();
            } else {
                this.authTab('login');
                this.setAuthMessage('تم إنشاء الحساب. افتح بريدك واضغط رابط التأكيد ثم سجّل الدخول.', 'success');
            }
        } catch (e) {
            this.setAuthMessage(e.message || 'تعذر إنشاء الحساب', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async logout() {
        if (!confirm('هل أنت متأكد من تسجيل الخروج؟')) return;
        try { await window.zonoAuth.logout(); } catch (_) {}
        this.currentUser = null;
        this.showAuthModal();
        this.authTab('login');
        this.showToast('تم تسجيل الخروج بنجاح.');
    }

    switchTab(tabId) {
        if (window.zonoAudio) window.zonoAudio.playTap();
        this.currentTab = tabId;

        // Balances are visible only on the Counter tab.
        // visibility is used instead of display:none so the header height never changes.
        const currencyPill = document.getElementById('zono-currency-pill');
        const seedValuePill = document.getElementById('zono-seed-value-pill');
        if (currencyPill) {
            currencyPill.classList.toggle('counter-only-hidden', tabId !== 'counter');
        }
        if (seedValuePill) {
            seedValuePill.classList.toggle('counter-only-hidden', tabId !== 'counter');
        }

        // Hide all tabs
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });

        // Show active tab
        const targetTab = document.getElementById(`tab-${tabId}`);
        if (targetTab) {
            targetTab.classList.add('active');
        }

        // Update nav bar active states
        document.querySelectorAll('.nav-btn').forEach(btn => {
            const btnTab = btn.getAttribute('data-tab');
            if (btnTab === tabId) {
                btn.classList.add('text-amber-400', 'scale-105');
                btn.classList.remove('text-stone-400');
                const dot = btn.querySelector('.active-dot');
                if (dot) dot.classList.remove('hidden');
            } else {
                btn.classList.remove('text-amber-400', 'scale-105');
                btn.classList.add('text-stone-400');
                const dot = btn.querySelector('.active-dot');
                if (dot) dot.classList.add('hidden');
            }
        });

        // Trigger resize/redraw on bird canvas if navigating to counter
        if (tabId === 'counter' && this.birdEngine) {
            this.birdEngine.updateUI();
        }
        if (tabId === 'birds') {
            this.renderStore();
        }

    }

    updateHeaderUI() {
        if (!this.currentUser) return;
        const nameEl = document.getElementById('header-user-name');
        const feathersEl = document.getElementById('header-feathers-count');
        const seedsEl = document.getElementById('header-seeds-count');
        const avatarEl = document.getElementById('header-user-avatar');

        const fitCurrencyNumber = (el, value) => {
            if (!el) return;

            const text = String(Math.max(0, Number(value || 0)));
            el.textContent = text;

            // Only the number shrinks. "ريشة" / "بذرة" always stay visible.
            const digits = text.length;
            let size = '0.76rem';

            if (digits >= 6)  size = '0.69rem';
            if (digits >= 8)  size = '0.61rem';
            if (digits >= 10) size = '0.54rem';
            if (digits >= 12) size = '0.47rem';
            if (digits >= 14) size = '0.41rem';
            if (digits >= 16) size = '0.36rem';

            el.style.fontSize = size;
            el.style.lineHeight = '1';
            el.style.minWidth = '0';
            el.style.maxWidth = window.innerWidth <= 390 ? '4.65rem'
                               : window.innerWidth <= 640 ? '5.7rem'
                               : '7.5rem';
            el.style.overflow = 'hidden';
            el.style.whiteSpace = 'nowrap';
            el.style.textAlign = 'center';
            el.style.fontVariantNumeric = 'tabular-nums';
        };

        if (nameEl) nameEl.textContent = this.currentUser.displayName;
        fitCurrencyNumber(feathersEl, this.currentUser.feathers);
        fitCurrencyNumber(seedsEl, this.currentUser.seeds);

        // Seed value: 500 seeds = 500 IQD, therefore 1 seed = 1 IQD.
        const seedValueSeedsEl = document.getElementById('zono-value-seeds-count');
        const seedValueIqdEl = document.getElementById('zono-value-iqd-count');
        const seedBalance = Math.max(0, Number(this.currentUser.seeds || 0));
        const seedValueIqd = seedBalance;

        const fitValueNumber = (el, value) => {
            if (!el) return;

            const text = Number(value || 0).toLocaleString('en-US');
            el.textContent = text;

            const digits = String(Math.trunc(Number(value || 0))).length;
            let size = '0.74rem';
            if (digits >= 7)  size = '0.66rem';
            if (digits >= 9)  size = '0.58rem';
            if (digits >= 11) size = '0.50rem';
            if (digits >= 13) size = '0.43rem';
            if (digits >= 15) size = '0.37rem';

            el.style.fontSize = size;
            el.style.lineHeight = '1';
            el.style.minWidth = '0';
            el.style.maxWidth = window.innerWidth <= 390 ? '4.65rem'
                               : window.innerWidth <= 640 ? '5.65rem'
                               : '7.5rem';
            el.style.overflow = 'hidden';
            el.style.whiteSpace = 'nowrap';
            el.style.textAlign = 'center';
            el.style.fontVariantNumeric = 'tabular-nums';
        };

        fitValueNumber(seedValueSeedsEl, seedBalance);
        fitValueNumber(seedValueIqdEl, seedValueIqd);
        if (avatarEl) avatarEl.src = this.currentUser.avatar;
    }

    updateProfileUI() {
        if (!this.currentUser) return;
        const profileName = document.getElementById('profile-display-name');
        const profileUser = document.getElementById('profile-kik-username');
        const profileBio = document.getElementById('profile-bio-text');
        const profileAvatar = document.getElementById('profile-avatar-img');
        const profileBadge = document.getElementById('profile-badge-pill');
        const profileHours = document.getElementById('stat-flight-hours');
        const profileRooms = document.getElementById('stat-rooms-count');
        const profileMsgs = document.getElementById('stat-messages-count');
        const profileFeathers = document.getElementById('profile-feathers-val');
        const profileSeeds = document.getElementById('profile-seeds-val');
        const dailySeedsStat = document.getElementById('bird-daily-seeds-stat');
        const dailySeedsTotalEl = document.getElementById('bird-daily-seeds-total');
        const dailyFeathersTotalEl = document.getElementById('bird-daily-feathers-total');

        if (profileName) profileName.textContent = this.currentUser.displayName;
        if (profileUser) profileUser.textContent = `ID: ${this.currentUser.username}`;
        if (profileBio) profileBio.textContent = this.currentUser.bio;
        if (profileAvatar) profileAvatar.src = this.currentUser.avatar;
        if (profileBadge) profileBadge.textContent = this.currentUser.badge;
        if (profileHours) profileHours.textContent = `${this.currentUser.stats.flightHours} س`;
        if (profileRooms) profileRooms.textContent = this.currentUser.stats.roomsCreated;
        if (profileMsgs) profileMsgs.textContent = this.currentUser.stats.messagesSent;
        if (profileFeathers) profileFeathers.textContent = `${this.currentUser.feathers} ريشة`;
        if (profileSeeds) profileSeeds.textContent = `${this.currentUser.seeds} بذرة`;
        if (dailySeedsStat) {
            dailySeedsStat.textContent = this.currentUser.dailySeedsTotal
                ? `${Number(this.currentUser.dailySeedsTotal).toLocaleString('en-US')}+`
                : '0';
        }
        if (dailySeedsTotalEl) {
            dailySeedsTotalEl.textContent = Number(this.currentUser.dailySeedsTotal || 0).toLocaleString('en-US');
        }
        if (dailyFeathersTotalEl) {
            dailyFeathersTotalEl.textContent = Number(this.currentUser.dailyFeathersTotal || 60).toLocaleString('en-US');
        }
    }

    addFeathers() {
        // رصيد الريش لا يُعدّل من المتصفح. كل عمليات الإضافة تتم من Supabase.
        this.showToast('رصيد الريش يُدار من النظام بشكل آمن.', 'info');
    }

    // --- Rooms System (الرومات) ---
    getSampleRooms() {
        return [
            {
                id: 'room_1',
                title: 'مجلس الفلسفة والنوستالجيا 📜',
                category: 'أدب وحوار',
                desc: 'نتحدث عن ذكريات الماضي الجميل، أيام المسنجر والكيك، مع مقطوعات أدبية راقية.',
                membersCount: 42,
                isVoiceActive: true,
                badge: 'نشط جداً 🔥',
                bgGradient: 'from-amber-950/60 to-stone-900/90',
                icon: '📜',
                messages: [
                    { sender: 'أبو خلدون', text: 'أيام تطبيق Kik كانت مليئة بالبساطة والروقان الحقيقي.', time: '10:14 م', isBot: false },
                    { sender: 'سلاف الكلاسيكية', text: 'صحيح والله، والآن زونو يعيد نفس هذا الإحساس الفخم!', time: '10:15 م', isBot: false },
                    { sender: 'عمر النوستالجي', text: 'مين يذكر شارات S و D و R الكلاسيكية؟ متعة!', time: '10:18 م', isBot: false }
                ]
            },
            {
                id: 'room_2',
                title: 'قهوة الكيك وسوالف الليل ☕',
                category: 'سوالف عامة',
                desc: 'مقهى زونو الليلي للسوالف الدافئة، الضحك، والمواقف الطريفة.',
                membersCount: 88,
                isVoiceActive: true,
                badge: 'صوتي مباشر 🎙️',
                bgGradient: 'from-emerald-950/60 to-slate-900/90',
                icon: '☕',
                messages: [
                    { sender: 'ندى الأمل', text: 'مساء الخير والقهوة المظبوطة على الجميع ☕✨', time: '09:40 م', isBot: false },
                    { sender: 'حمد الزمان', text: 'يا هلا يا ندى، حياكم جميعاً في الروم الأجمل.', time: '09:45 م', isBot: false }
                ]
            },
            {
                id: 'room_3',
                title: 'أوتار الموسيقى والزمن الجميل 🎻',
                category: 'فنون وموسيقى',
                desc: 'مساحة هادئة لعشاق الطرب الأصيل والأنغام الكلاسيكية الهادئة.',
                membersCount: 31,
                isVoiceActive: false,
                badge: 'هادئ 🎼',
                bgGradient: 'from-purple-950/60 to-stone-900/90',
                icon: '🎻',
                messages: [
                    { sender: 'عازف القانون', text: 'ما أجمل تقاسيم البيات في ليلة هادئة كهذه.', time: '08:20 م', isBot: false }
                ]
            },
            {
                id: 'room_4',
                title: 'مختبر التقنية والتطوير ⚙️',
                category: 'تقنية وبرمجة',
                desc: 'نقاشات حول أحدث التقنيات مع الحفاظ على بساطة وأناقة التصاميم القديمة.',
                membersCount: 54,
                isVoiceActive: true,
                badge: 'رواد 🚀',
                bgGradient: 'from-cyan-950/60 to-slate-900/90',
                icon: '⚙️',
                messages: [
                    { sender: 'مهندس حسام', text: 'دمج تقنيات الكانفاس مع العداد الـ 24 ساعة فكرة مذهلة في زونو.', time: '07:11 م', isBot: false }
                ]
            },
            {
                id: 'room_5',
                title: 'مجلس العصفور الطائر 🕊️',
                category: 'تحديات وإنتاجية',
                desc: 'غرفة خاصة بمتابعي عداد طيران العصفور وتحديات التركيز اليومية.',
                membersCount: 120,
                isVoiceActive: true,
                badge: 'مكافآت 🏆',
                bgGradient: 'from-yellow-950/60 to-stone-900/90',
                icon: '🕊️',
                messages: [
                    { sender: 'سالم الطيار', text: 'عصفوري طائر منذ 8 ساعات متواصلة! من يتحداني؟ 🕊️', time: '10:02 م', isBot: false }
                ]
            },
            {
                id: 'room_6',
                title: 'صالون الألعاب والمسابقات 🎲',
                category: 'تسلية وألغاز',
                desc: 'ألغاز كلاسيكية، مسابقات سرعة بديهة، وجوائز ريشات ذهبية.',
                membersCount: 65,
                isVoiceActive: false,
                badge: 'ألعاب 🎮',
                bgGradient: 'from-rose-950/60 to-stone-900/90',
                icon: '🎲',
                messages: [
                    { sender: 'حكم اللعبة', text: 'اللغز القادم يبدأ بعد 5 دقائق! استعدوا.', time: '09:55 م', isBot: false }
                ]
            }
        ];
    }

    renderRooms() {
        const container = document.getElementById('rooms-list-container');
        if (!container) return;
        const rooms = this.getSampleRooms();

        container.innerHTML = rooms.map(room => `
            <div class="glass-panel p-5 rounded-2xl hover:border-amber-500/50 transition-all duration-300 transform hover:-translate-y-1 cursor-pointer relative overflow-hidden group shadow-lg" onclick="window.zonoApp.openRoom('${room.id}')">
                <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${room.bgGradient}"></div>
                <div class="flex items-start justify-between mb-3">
                    <div class="flex items-center space-x-3 space-x-reverse">
                        <div class="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-2xl shadow-inner group-hover:scale-110 transition-transform">
                            ${room.icon}
                        </div>
                        <div>
                            <h3 class="font-bold text-base text-stone-100 group-hover:text-amber-300 transition-colors">${room.title}</h3>
                            <span class="text-xs text-amber-400/80 font-medium">${room.category}</span>
                        </div>
                    </div>
                    <span class="badge-pill bg-stone-800/80 text-amber-300 border border-amber-500/30">
                        ${room.badge}
                    </span>
                </div>
                <p class="text-xs text-stone-300 line-clamp-2 mb-4 leading-relaxed">${room.desc}</p>
                <div class="flex items-center justify-between pt-3 border-t border-stone-800/60 text-xs text-stone-400">
                    <div class="flex items-center space-x-1.5 space-x-reverse">
                        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                        <span class="font-semibold text-stone-300">${room.membersCount} متواجد</span>
                    </div>
                    ${room.isVoiceActive ? `
                        <div class="flex items-center space-x-1.5 space-x-reverse text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-full border border-emerald-500/30">
                            <span class="voice-wave">
                                <span class="voice-bar"></span>
                                <span class="voice-bar"></span>
                                <span class="voice-bar"></span>
                            </span>
                            <span class="text-[11px] font-bold">بث صوتي</span>
                        </div>
                    ` : `
                        <span class="text-stone-400 text-[11px]">محادثة نصية</span>
                    `}
                </div>
            </div>
        `).join('');
    }

    openRoom(roomId) {
        if (window.zonoAudio) window.zonoAudio.playClick();
        const rooms = this.getSampleRooms();
        this.activeRoom = rooms.find(r => r.id === roomId);
        if (!this.activeRoom) return;

        const modal = document.getElementById('room-chat-modal');
        const titleEl = document.getElementById('room-modal-title');
        const countEl = document.getElementById('room-modal-count');
        const container = document.getElementById('room-messages-flow');

        if (titleEl) titleEl.textContent = this.activeRoom.title;
        if (countEl) countEl.textContent = `${this.activeRoom.membersCount} عضو في الروم`;

        this.renderRoomMessages();
        if (modal) modal.classList.remove('hidden');
    }

    renderRoomMessages() {
        const container = document.getElementById('room-messages-flow');
        if (!container || !this.activeRoom) return;

        container.innerHTML = this.activeRoom.messages.map(msg => {
            const isMe = this.currentUser && msg.sender === this.currentUser.displayName;
            return `
                <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-3">
                    <div class="flex items-center space-x-1.5 space-x-reverse text-[11px] text-amber-400/90 mb-1 px-1 font-semibold">
                        <span>${msg.sender}</span>
                        <span class="text-stone-400 text-[9px] font-normal">${msg.time}</span>
                    </div>
                    <div class="p-3 rounded-2xl max-w-[85%] text-sm ${isMe ? 'bubble-sent text-emerald-100' : 'bubble-rcvd text-stone-200'} shadow">
                        ${msg.text}
                    </div>
                </div>
            `;
        }).join('');

        container.scrollTop = container.scrollHeight;
    }

    sendRoomMessage() {
        const input = document.getElementById('room-message-input');
        if (!input || !input.value.trim() || !this.activeRoom) return;

        const text = input.value.trim();
        input.value = '';

        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

        this.activeRoom.messages.push({
            sender: this.currentUser ? this.currentUser.displayName : 'أنا',
            text: text,
            time: timeStr,
            isMe: true
        });

        if (this.currentUser) {
            this.currentUser.stats.messagesSent++;
            this.saveUser();
        }

        if (window.zonoAudio) window.zonoAudio.playKikSent();
        this.renderRoomMessages();

        // Simulate interactive room reply
        setTimeout(() => {
            const botReplies = [
                'كلامك ذهب والله! ☕✨',
                'يا سلام على الذكريات الطيبة.',
                'أحسنت القول، زونو يجمعنا دائماً 🕊️',
                'فعلاً هذا أجمل ما في الروم!'
            ];
            const botNames = ['عمر النوستالجي', 'سلاف الكلاسيكية', 'ندى الأمل', 'حمد الزمان'];
            const randomReply = botReplies[Math.floor(Math.random() * botReplies.length)];
            const randomBot = botNames[Math.floor(Math.random() * botNames.length)];

            this.activeRoom.messages.push({
                sender: randomBot,
                text: randomReply,
                time: `${now.getHours()}:${String(now.getMinutes() + 1).padStart(2, '0')}`,
                isMe: false
            });

            if (window.zonoAudio) window.zonoAudio.playKikReceived();
            this.renderRoomMessages();
        }, 1800);
    }

    closeRoomModal() {
        const modal = document.getElementById('room-chat-modal');
        if (modal) modal.classList.add('hidden');
        this.activeRoom = null;
    }

    // --- Direct Messages (قسم الخاص - Kik Style) ---
    getSampleDirectChats() {
        return [
            {
                id: 'dm_1',
                name: 'سارة الكلاسيكية',
                username: 'sarah_vintage',
                avatar: 'https://api.dicebear.com/7.x/micah/svg?seed=sarah_vintage',
                status: 'online',
                lastMessage: 'هل قمت بتفعيل عصفور الـ 24 ساعة اليوم؟ 🕊️',
                time: '10:20 م',
                unread: 1,
                kikState: 'D', // S, D, R
                messages: [
                    { sender: 'other', text: 'أهلاً بك في زونو! كيف تجد التصميم الكلاسيكي؟', time: '10:15 م', status: 'R' },
                    { sender: 'me', text: 'رائع جداً ويذكرني بأيام الكيك الجميلة!', time: '10:18 م', status: 'R' },
                    { sender: 'other', text: 'هل قمت بتفعيل عصفور الـ 24 ساعة اليوم؟ 🕊️', time: '10:20 م', status: 'D' }
                ]
            },
            {
                id: 'dm_2',
                name: 'عمر النوستالجي',
                username: 'omar_retro',
                avatar: 'https://api.dicebear.com/7.x/micah/svg?seed=omar_retro',
                status: 'offline',
                lastMessage: 'أراك في روم مجلس الفلسفة الليلة.',
                time: 'أمس',
                unread: 0,
                kikState: 'R',
                messages: [
                    { sender: 'other', text: 'مساء الخير يا صديقي', time: 'أمس', status: 'R' },
                    { sender: 'me', text: 'مساء النور عمر', time: 'أمس', status: 'R' },
                    { sender: 'other', text: 'أراك في روم مجلس الفلسفة الليلة.', time: 'أمس', status: 'R' }
                ]
            },
            {
                id: 'dm_3',
                name: 'بوت زونو الذكي 🤖',
                username: 'zono_bot',
                avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=zono_bot_ai',
                status: 'online',
                lastMessage: 'أهلاً بك! أنا مرشدك في زونو، اسألني أي شيء.',
                time: '08:00 ص',
                unread: 0,
                kikState: 'R',
                messages: [
                    { sender: 'other', text: 'مرحباً بك في تطبيق زونو! يمكنك الضغط على دائرة العصفور في قسم العداد ليبدأ الطيران لـ 24 ساعة كاملة وتكسب ريشات ذهبية! 🕊️✨', time: '08:00 ص', status: 'R' }
                ]
            }
        ];
    }

    renderDirectChats() {
        const container = document.getElementById('direct-chats-container');
        if (!container) return;
        const chats = this.getSampleDirectChats();

        container.innerHTML = chats.map(chat => `
            <div class="glass-panel p-4 rounded-2xl flex items-center justify-between hover:border-amber-500/50 cursor-pointer transition-all duration-200 group" onclick="window.zonoApp.openDirectChat('${chat.id}')">
                <div class="flex items-center space-x-3 space-x-reverse">
                    <div class="relative">
                        <img src="${chat.avatar}" alt="${chat.name}" class="w-13 h-13 rounded-full border-2 border-amber-500/40 bg-stone-900 p-0.5 object-cover">
                        <span class="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full ${chat.status === 'online' ? 'bg-emerald-500' : 'bg-stone-500'} border-2 border-stone-900"></span>
                    </div>
                    <div>
                        <div class="flex items-center space-x-2 space-x-reverse">
                            <h4 class="font-bold text-stone-100 group-hover:text-amber-300 transition-colors text-sm">${chat.name}</h4>
                            <span class="text-[10px] text-stone-400">@${chat.username}</span>
                        </div>
                        <p class="text-xs text-stone-300 mt-1 line-clamp-1 flex items-center">
                            <span class="kik-status kik-status-${chat.kikState.toLowerCase()}">${chat.kikState}</span>
                            <span>${chat.lastMessage}</span>
                        </p>
                    </div>
                </div>
                <div class="flex flex-col items-end space-y-1.5">
                    <span class="text-[10px] text-stone-400 font-mono">${chat.time}</span>
                    ${chat.unread > 0 ? `
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-stone-950 text-[10px] font-bold flex items-center justify-center shadow-lg shadow-emerald-500/40 animate-pulse">
                            ${chat.unread}
                        </span>
                    ` : ''}
                </div>
            </div>
        `).join('');
    }

    openDirectChat(chatId) {
        if (window.zonoAudio) window.zonoAudio.playClick();
        const chats = this.getSampleDirectChats();
        this.activeDirectChat = chats.find(c => c.id === chatId);
        if (!this.activeDirectChat) return;

        const modal = document.getElementById('direct-chat-modal');
        const nameEl = document.getElementById('dm-modal-name');
        const userEl = document.getElementById('dm-modal-user');
        const avatarEl = document.getElementById('dm-modal-avatar');

        if (nameEl) nameEl.textContent = this.activeDirectChat.name;
        if (userEl) userEl.textContent = `@${this.activeDirectChat.username}`;
        if (avatarEl) avatarEl.src = this.activeDirectChat.avatar;

        this.renderDirectMessages();
        if (modal) modal.classList.remove('hidden');
    }

    renderDirectMessages() {
        const container = document.getElementById('dm-messages-flow');
        if (!container || !this.activeDirectChat) return;

        container.innerHTML = this.activeDirectChat.messages.map(msg => {
            const isMe = msg.sender === 'me';
            return `
                <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} mb-3">
                    <div class="p-3.5 rounded-2xl max-w-[80%] text-sm ${isMe ? 'bubble-sent text-emerald-100' : 'bubble-rcvd text-stone-200'} shadow-md relative">
                        <p class="leading-relaxed">${msg.text}</p>
                        <div class="flex items-center justify-end space-x-1.5 space-x-reverse mt-1 text-[9px] ${isMe ? 'text-emerald-300/80' : 'text-stone-400'}">
                            <span>${msg.time}</span>
                            ${isMe ? `<span class="kik-status kik-status-${msg.status.toLowerCase()}">${msg.status}</span>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        container.scrollTop = container.scrollHeight;
    }

    sendDirectMessage() {
        const input = document.getElementById('dm-message-input');
        if (!input || !input.value.trim() || !this.activeDirectChat) return;

        const text = input.value.trim();
        input.value = '';

        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

        const msgObj = {
            sender: 'me',
            text: text,
            time: timeStr,
            status: 'S' // Sent initially
        };

        this.activeDirectChat.messages.push(msgObj);
        this.activeDirectChat.lastMessage = text;
        this.activeDirectChat.time = timeStr;

        if (this.currentUser) {
            this.currentUser.stats.messagesSent++;
            this.saveUser();
        }

        if (window.zonoAudio) window.zonoAudio.playKikSent();
        this.renderDirectMessages();
        this.renderDirectChats();

        // Simulate Kik status transition: S -> D -> R
        setTimeout(() => {
            msgObj.status = 'D'; // Delivered
            this.renderDirectMessages();
        }, 800);

        setTimeout(() => {
            msgObj.status = 'R'; // Read
            this.renderDirectMessages();
            this.showTypingIndicator(true);
        }, 1800);

        // Smart reply
        setTimeout(() => {
            this.showTypingIndicator(false);
            let replyText = "سعدت جداً بحديثك معي في زونو! 🕊️";
            if (this.activeDirectChat.id === 'dm_3') {
                replyText = "أنا هنا دائماً لمساعدتك في استكشاف ميزات زونو وعداد الـ 24 ساعة والأقسام المختلفة!";
            } else if (text.includes('عصفور') || text.includes('عداد')) {
                replyText = "العصفور في قسم العداد ميزة ساحرة، يبدأ الطيران لـ 24 ساعة بمجرد النقر عليه! 🌟";
            } else if (text.includes('كيك') || text.includes('kik')) {
                replyText = "يا سلام على أيام الكيك والنوستالجيا، زونو جمع بين جمال الماضي وسرعة الحاضر.";
            }

            this.activeDirectChat.messages.push({
                sender: 'other',
                text: replyText,
                time: `${now.getHours()}:${String(now.getMinutes() + 1).padStart(2, '0')}`,
                status: 'R'
            });

            if (window.zonoAudio) window.zonoAudio.playKikReceived();
            this.renderDirectMessages();
            this.renderDirectChats();
        }, 3600);
    }

    showTypingIndicator(show) {
        const typingEl = document.getElementById('dm-typing-indicator');
        if (typingEl) {
            if (show) typingEl.classList.remove('hidden');
            else typingEl.classList.add('hidden');
        }
    }

    closeDirectModal() {
        const modal = document.getElementById('direct-chat-modal');
        if (modal) modal.classList.add('hidden');
        this.activeDirectChat = null;
    }

    // --- Store System (المتجر) ---
    getStoreItems() {
        return [
            { id: 'classic_gold', rank: 0, name: 'العصفور الذهبي الكلاسيكي', price: 0, dailySeeds: 0, durationDays: 0, icon: '🕊️', desc: 'الشكل الأساسي لعصفور Zono.' },
            { id: 'emerald', rank: 1, name: 'الطائر الأخضر الملكي', price: 6000, dailySeeds: 500, durationDays: 500, icon: '🦜', desc: 'ينتج 500 بذرة يومياً لمدة 500 يوم.' },
            { id: 'royal_blue', rank: 2, name: 'طائر الجليد الأزرق', price: 9000, dailySeeds: 750, durationDays: 500, icon: '🐦', desc: 'ينتج 750 بذرة يومياً لمدة 500 يوم.' },
            { id: 'crimson_phoenix', rank: 3, name: 'طائر الكاردينال القرمزي', price: 12000, dailySeeds: 1000, durationDays: 500, icon: '🔴', desc: 'ينتج 1000 بذرة يومياً لمدة 500 يوم.' },
            { id: 'ivory_cockatiel', rank: 4, name: 'طائر الكوكتيل العاجي', price: 18000, dailySeeds: 1500, durationDays: 500, icon: '🪽', desc: 'ينتج 1500 بذرة يومياً لمدة 500 يوم.' },
            { id: 'obsidian_gold', rank: 5, name: 'النسر الأسود الذهبي', price: 30000, dailySeeds: 2500, durationDays: 500, icon: '🦅', desc: 'ينتج 2500 بذرة يومياً لمدة 500 يوم.' }
        ];
    }

    renderStore() {
        const container = document.getElementById('bird-shop-grid');
        if (!container) return;
        const items = this.getStoreItems();
        const activeRank = Number(this.currentUser?.activeBirdRank || 0);
        const activeSkin = this.currentUser?.activeBird || 'classic_gold';
        const seeds = Number(this.currentUser?.seeds || 0);
        const purchaseCounts = this.currentUser?.birdPurchaseCounts || {};

        container.innerHTML = items.map(item => {
            const isActive = activeSkin === item.id;
            const isPrevious = item.rank < activeRank;
            const canBuy = item.rank > 0;
            const affordable = seeds >= item.price;
            const ownedCount = Number(purchaseCounts[item.id] || 0);

            return `
                <div class="glass-panel p-5 rounded-2xl flex flex-col justify-between border ${isActive ? 'border-amber-400 shadow-amber-500/20 shadow-lg' : 'border-stone-800'} relative overflow-hidden">
                    <div>
                        <div class="flex items-center justify-between mb-3">
                            <span class="text-3xl p-2.5 rounded-xl bg-stone-900 border border-stone-800">${item.icon}</span>

                            <!-- هنا يظهر الإنتاج اليومي بدلاً من سعر الشراء -->
                            <span class="font-mono text-xs font-bold ${item.dailySeeds ? 'text-amber-400' : 'text-emerald-400'}">
                                ${item.dailySeeds
                                    ? `🌾 ${item.dailySeeds.toLocaleString('en-US')} يومياً`
                                    : 'أساسي'}
                            </span>
                        </div>

                        <h4 class="font-bold text-stone-100 text-sm mb-1">${item.name}</h4>
                        <div class="flex items-center justify-between gap-2 mb-1">
                            <span class="text-[11px] text-amber-300">رقم ${item.rank || 0}</span>
                            ${ownedCount > 0 ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950/50 border border-emerald-500/30 text-emerald-300">مملوك × ${ownedCount}</span>` : ''}
                        </div>

                        <p class="text-xs text-stone-300 leading-relaxed mb-2">${item.desc}</p>

                        ${item.dailySeeds ? `
                            <div class="text-[11px] text-stone-400 mb-2">
                                🌾 الإنتاج: ${item.dailySeeds.toLocaleString('en-US')} بذرة يومياً
                            </div>
                            <div class="text-[11px] text-stone-400 mb-4">
                                ⏳ مدة كل عملية شراء: ${item.durationDays} يوم
                            </div>
                        ` : '<div class="mb-4"></div>'}
                    </div>

                    <div>
                        ${isPrevious ? `
                            <div class="mb-2 text-center text-[10px] text-stone-400 font-bold">
                                🔒 شكل سابق — الشراء يزيد الإنتاج فقط ولن يغيّر شكلك الحالي
                            </div>
                            <button onclick="window.zonoApp.buyItem('${item.id}', ${item.price})" class="w-full py-2 rounded-xl text-xs font-bold ${affordable ? 'bg-gradient-to-r from-amber-600 via-yellow-500 to-amber-600 hover:from-amber-500 hover:to-yellow-500 text-stone-950' : 'bg-stone-800 text-stone-500'} transition-all shadow">
                                ${ownedCount > 0 ? 'شراء مرة أخرى' : 'شراء'} بـ ${item.price.toLocaleString('en-US')} بذرة
                            </button>
                        ` : canBuy ? `
                            ${isActive ? `<div class="mb-2 text-center text-[10px] text-emerald-300 font-bold">✨ الشكل الحالي — يمكنك شراءه مرة أخرى</div>` : ''}
                            <button onclick="window.zonoApp.buyItem('${item.id}', ${item.price})" class="w-full py-2 rounded-xl text-xs font-bold ${affordable ? 'bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 text-stone-950' : 'bg-stone-800 text-stone-500'} transition-all shadow">
                                ${ownedCount > 0 ? 'شراء مرة أخرى' : 'شراء'} بـ ${item.price.toLocaleString('en-US')} بذرة
                            </button>
                        ` : isActive ? `
                            <div class="w-full py-2 rounded-xl text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 text-center">
                                الشكل الحالي ✨
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    async buyItem(itemId, price) {
        if (!this.currentUser) return this.showAuthModal();
        const item = this.getStoreItems().find(x => x.id === itemId);
        if (!item || item.rank <= 0) {
            return this.showToast('هذا الطائر غير متاح للشراء', 'error');
        }
        try {
            const { data, error } = await window.zunoBackend.client.rpc('zono_buy_bird', { p_item_id: itemId });
            if (error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();

            // The new bird is equipped automatically and replaces the old appearance.
            if (this.birdEngine) this.birdEngine.setSkin(itemId);
            if (window.zonoAudio) window.zonoAudio.playChirp();
            const purchaseNo = Number(data?.purchase_count || this.currentUser?.birdPurchaseCounts?.[itemId] || 1);
            this.showToast(`تم شراء ${item.name} للمرة ${purchaseNo} مقابل ${data?.price ?? price} بذرة 🌾 — زاد إنتاجك اليومي`, 'success');
            this.renderStore();
        } catch (e) {
            this.showToast(e.message || 'تعذر شراء الطائر', 'error');
        }
    }

    async equipItem(itemId, itemType) {
        // Deliberately disabled: upgrades are permanent and older birds cannot be re-equipped.
        this.showToast('الترقية دائمة ولا يمكن الرجوع إلى شكل طائر أقدم', 'error');
    }

    async claimBirdDailySeeds() {
        if (!this.currentUser) return { ok: false };
        try {
            const { data, error } = await window.zunoBackend.client.rpc('zono_claim_bird_daily_seeds');
            if (error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            if (window.zonoAudio) window.zonoAudio.playCoin();
            this.showToast(`اكتملت الرحلة اليومية: +${data?.reward || 0} بذرة 🌾`, 'success');
            return data || { ok: true };
        } catch (e) {
            this.showToast(e.message || 'تعذر استلام بذور اليوم', 'error');
            return { ok: false, error: e.message };
        }
    }

    async claimDailyReward() {
        if (!this.currentUser) return this.showAuthModal();
        try {
            const { data, error } = await window.zunoBackend.client.rpc('zono_claim_daily_feathers');
            if (error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            if (window.zonoAudio) window.zonoAudio.playCoin();
            this.showToast(`تم استلام مكافأة اليوم: +${data?.reward || 60} ريشة 🪶✨`, 'success');
        } catch (e) {
            this.showToast(e.message || 'المكافأة غير متاحة الآن', 'error');
        }
    }

    // --- News / Gazette (جريدة زونو للأخبار) ---
    getSampleNews() {
        return [
            {
                id: 'news_1',
                title: 'انطلاق النسخة الكلاسيكية الفاخرة من تطبيق زونو بحلته الجديدة',
                category: 'بيان رسمي 📢',
                date: '31 أغسطس 2026 - العدد الأول',
                author: 'رئيس التحرير الكلاسيكي',
                image: 'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=600&auto=format&fit=crop&q=80',
                snippet: 'يسر إدارة زونو أن تعلن عن إطلاق المنصة الكلاسيكية التي تجمع عشاق النوستالجيا، مع تدشين ميزة عداد الـ 24 ساعة لعصفور زونو الرمزي وغرف المحادثة الحية.',
                likes: 184,
                comments: 45
            },
            {
                id: 'news_2',
                title: 'تقرير خاص: كيف يعيد زونو إحياء علامات Kik الأيقونية (S/D/R)؟',
                category: 'تحليلات ونوستالجيا 🗞️',
                date: '30 أغسطس 2026',
                author: 'أرشيف الزمن الجميل',
                image: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=80',
                snippet: 'من منا ينسى شعور انتظار تحول حرف S إلى D ثم R باللون الأخضر المميز؟ نلقي الضوء على الفلسفة التصميمية لدمج هذه المؤشرات مع الشات الحديث.',
                likes: 240,
                comments: 62
            },
            {
                id: 'news_3',
                title: 'تحدي طيران العصفور: أكثر من 10,000 ساعة طيران مسجلة في الأسبوع الأول',
                category: 'إنجازات المجتمع 🕊️',
                date: '29 أغسطس 2026',
                author: 'قسم العدادات الفلكية',
                image: 'https://images.unsplash.com/photo-1552728089-57bdde30beb3?w=600&auto=format&fit=crop&q=80',
                snippet: 'أظهر مستخدمو زونو تفاعلاً استثنائياً مع عداد الـ 24 ساعة، حيث وصل عدد الساعات المنجزة لأرقام قياسية وتوزيع أوسمة الطيران النادرة.',
                likes: 312,
                comments: 89
            }
        ];
    }

    renderNews() {
        const container = document.getElementById('news-articles-flow');
        if (!container) return;
        const news = this.getSampleNews();

        container.innerHTML = news.map(article => `
            <div class="glass-panel rounded-2xl overflow-hidden border border-stone-800/80 hover:border-amber-500/40 transition-all duration-300 mb-6 shadow-xl">
                <div class="p-5 pb-3">
                    <div class="flex items-center justify-between text-xs text-amber-400 font-semibold mb-2">
                        <span>${article.category}</span>
                        <span class="text-stone-400 font-mono">${article.date}</span>
                    </div>
                    <h3 class="newspaper-headline text-lg font-bold text-stone-100 hover:text-amber-300 transition-colors mb-2 cursor-pointer">
                        ${article.title}
                    </h3>
                    <p class="text-xs text-stone-300 leading-relaxed mb-4">${article.snippet}</p>
                </div>
                <div class="px-5 py-3 bg-stone-900/60 border-t border-stone-800/60 flex items-center justify-between text-xs text-stone-400">
                    <div class="flex items-center space-x-1.5 space-x-reverse">
                        <span class="text-amber-400">بقلم:</span>
                        <span class="text-stone-300 font-medium">${article.author}</span>
                    </div>
                    <div class="flex items-center space-x-4 space-x-reverse">
                        <button onclick="window.zonoApp.likeNews(this)" class="flex items-center space-x-1 space-x-reverse hover:text-red-400 transition-colors">
                            <span>❤️</span>
                            <span>${article.likes}</span>
                        </button>
                        <button class="flex items-center space-x-1 space-x-reverse hover:text-amber-300 transition-colors">
                            <span>💬</span>
                            <span>${article.comments}</span>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    likeNews(btn) {
        if (window.zonoAudio) window.zonoAudio.playTap();
        const span = btn.querySelector('span:last-child');
        if (span) {
            let count = parseInt(span.textContent, 10);
            span.textContent = count + 1;
            btn.classList.add('text-red-400');
        }
        this.showToast('شكراً لتفاعلك مع الخبر! ❤️');
    }

    votePoll(optionIndex) {
        if (window.zonoAudio) window.zonoAudio.playTap();
        this.showToast('تم تسجيل صوتك في استطلاع الرأي بنجاح! 🗳️');
        const pollContainer = document.getElementById('news-poll-container');
        if (pollContainer) {
            pollContainer.innerHTML = `
                <div class="p-4 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-300 text-center font-bold">
                    ✓ شكراً لمشاركتك! نسبة اختيارك بلغت 68% بين مجتمع زونو.
                </div>
            `;
        }
    }

    // --- Toast Notifications ---
    showToast(message, type = 'info') {
        const toastEl = document.getElementById('zono-toast');
        if (!toastEl) return;

        toastEl.textContent = message;
        toastEl.className = "fixed left-1/2 transform -translate-x-1/2 px-5 py-2.5 rounded-2xl text-xs font-bold z-50 backdrop-blur-xl shadow-2xl transition-all duration-300 border text-center leading-relaxed " +
            (type === 'error' ? 'bg-red-950/90 text-red-200 border-red-500/50 shadow-red-900/40' :
             type === 'success' ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/50 shadow-emerald-900/40' :
             'bg-stone-900/90 text-amber-200 border-amber-500/40 shadow-amber-900/30');

        /* Keep notifications below the phone status bar + Zono header */
        toastEl.style.top = 'calc(env(safe-area-inset-top, 0px) + 5.8rem)';
        toastEl.style.width = 'max-content';
        toastEl.style.maxWidth = '88vw';

        toastEl.classList.remove('opacity-0', 'pointer-events-none', '-translate-y-4');
        toastEl.classList.add('opacity-100', 'translate-y-0');

        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toastEl.classList.add('opacity-0', 'pointer-events-none', '-translate-y-4');
            toastEl.classList.remove('opacity-100', 'translate-y-0');
        }, 3200);
    }

    // --- Edit Profile ---
    openEditProfileModal() {
        if (!this.currentUser) return;
        const modal = document.getElementById('edit-profile-modal');
        const nameInput = document.getElementById('edit-display-name-input');
        const bioInput = document.getElementById('edit-bio-input');

        if (nameInput) nameInput.value = this.currentUser.displayName;
        if (bioInput) bioInput.value = this.currentUser.bio;
        if (modal) modal.classList.remove('hidden');
    }

    async saveEditedProfile() {
        if (!this.currentUser) return;
        const nameInput = document.getElementById('edit-display-name-input');
        const bioInput = document.getElementById('edit-bio-input');

        try {
            if (nameInput && nameInput.value.trim() && nameInput.value.trim() !== this.currentUser.displayName) {
                await window.zonoAuth.updateDisplayName(nameInput.value.trim());
            }
            const bio = (bioInput?.value || '').trim();
            const { error } = await window.zunoBackend.client.rpc('zono_update_bio', { p_bio: bio });
            if (error) throw error;

            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            this.closeEditProfileModal();
            if (window.zonoAudio) window.zonoAudio.playTap();
            this.showToast('تم تحديث بيانات الملف الشخصي بنجاح! ✨', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر حفظ التغييرات', 'error');
        }
    }

    closeEditProfileModal() {
        const modal = document.getElementById('edit-profile-modal');
        if (modal) modal.classList.add('hidden');
    }

    // --- Bird Extra Actions ---
    feedBird() {
        if (!this.birdEngine) return;
        if (window.zonoAudio) window.zonoAudio.playChirp();
        for (let i = 0; i < 15; i++) {
            this.birdEngine.spawnParticle(this.birdEngine.birdPos.x, this.birdEngine.birdPos.y, true);
        }
        this.showToast('تم إطعام العصفور حبوب الطاقة! أصبح يرفرف بحيوية أعلى 🌾🕊️');
    }

    boostFlight() {
        if (!this.birdEngine || !this.birdEngine.isFlying) {
            this.showToast('قم بإطلاق العصفور أولاً لتتمكن من تعزيز سرعته!', 'info');
            return;
        }
        this.birdEngine.wingSpeed = 0.4;
        setTimeout(() => {
            if (this.birdEngine) this.birdEngine.wingSpeed = 0.2;
        }, 5000);
        if (window.zonoAudio) window.zonoAudio.playChirp();
        this.showToast('تم تعزيز طاقة الطيران والتحليق السريع لـ 5 ثوانٍ! ⚡');
    }

    bindEvents() {
        // Global helper for toast
        window.showZonoToast = (msg, type) => this.showToast(msg, type);

        // Enter key in chat inputs
        const roomInput = document.getElementById('room-message-input');
        if (roomInput) {
            roomInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.sendRoomMessage();
            });
        }

        const dmInput = document.getElementById('dm-message-input');
        if (dmInput) {
            dmInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.sendDirectMessage();
            });
        }
    }
}

// Global initialization
window.addEventListener('DOMContentLoaded', () => {
    window.zonoApp = new ZonoApp();
});
