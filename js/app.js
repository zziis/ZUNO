class ZonoApp {
    constructor() {
        this.notificationWatcher = null;
        this.banWatcher = null;
        this.lastNotificationId = 0;
        this.notificationsPrimed = false;
        this.historyPeriod = 'day';

        this.currentUser = null;
        this.currentTab = 'rooms';
        this.activeRoom = null;
        this.activeDirectChat = null;
        this.rooms = [];
        this.roomFilter = 'all';
        this.roomSearch = '';
        this.roomMembers = [];
        this.activeRoom = null;
        this.pendingProtectedRoom = null;
        this.roomPollTimer = null;
        this.roomPresenceTimer = null;
        this.selectedGift = 'rose';
        this.roomMicState = null;
        this.voiceRecorder = null;
        this.voiceChunks = [];
        this.recordedVoiceBlob = null;
        this.recordedVoiceUrl = null;
        this.voiceStartedAt = null;
        this.voiceMaxTimer = null;
        this.previewVoiceAudio = null;
        this.sendingRecordedVoice = false;

        this.roomMusicState = null;
        this.roomMusicSongs = [];
        this.roomMusicIsStaff = false;
        this.roomMusicIsOwner = false;
        this.roomMusicAudio = null;
        this.roomMusicVolume = Number(localStorage.getItem('zono_room_music_volume') || 70) / 100;
        this.roomMusicMuted = localStorage.getItem('zono_room_music_muted') === 'true';

        this.activeVoiceAudio = null;
        this.activeVoiceButton = null;
        this.roomInitialMessagesLoaded = false;
        this.birdEngine = null;
        this.theme = localStorage.getItem('zono_theme') || 'classic_night';
        this.ownedThemes = new Set(['classic_night','daylight']);
        this.readReceiptsEnabled = true;
        this.activeNameTheme = 'basic';
        this.ownedNameThemes = new Set();
        this.activeBirdTheme = 'bird_basic';
        this.ownedBirdThemes = new Set();
        this.activeAvatarFrame = 'frame_basic';
        this.ownedAvatarFrames = new Set();
        this.soundEnabled = localStorage.getItem('zono_sound') !== 'false';
        this.init();
    }

    async init() {
        this.applyTheme(this.theme);
        this.bindEvents();
        this.loadRooms();
        this.renderDirectChats();
        this.renderNews();

        if (window.zonoAudio) window.zonoAudio.enabled = this.soundEnabled;

        try {
            const logged = await window.zonoAuth.init();
            if (logged) {
                const blocked = await this.enforceCurrentUserBan();
                if (blocked) return;
                await this.syncUserFromSupabase();
                await this.loadThemeState();
                await this.loadCosmeticThemeState();
                this.showMainApp();
                await this.loadNotifications(true);
                this.startNotificationWatcher();
                this.startBanWatcher();
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
            publicId: Number(p.public_id || 0),
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
            role: p.role || 'user',
            agentVerified: p.agent_verified === true,
            agentSince: p.agent_since || null,
            agentPreviousPublicId: p.agent_previous_public_id || null,
            readReceiptsEnabled: p.read_receipts_enabled !== false,
            activeTheme: p.active_theme || 'classic_night',
            activeNameTheme: p.active_name_theme || 'basic',
            activeBirdTheme: p.active_bird_theme || 'bird_basic',
            activeAvatarFrame: p.active_avatar_frame || 'frame_basic',
            badge: p.role === 'developer' ? '✓ 👑 المطور' : (p.role === 'agent' ? '✓ 🛡️ الوكيل' : 'عضو Zono 🕊️'),
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

    getThemeCatalog() {
        return [
            { key:'classic_night', name:'الأساسي الليلي', icon:'🌙', price:0, desc:'أسود وكحلي مع اللمسة الذهبية الكلاسيكية.', preview:'theme-preview-night' },
            { key:'daylight', name:'النهاري', icon:'☀️', price:0, desc:'عاجي هادئ مع ذهبي ونصوص داكنة واضحة.', preview:'theme-preview-daylight' },
            { key:'lunar', name:'القمري', icon:'🌑', price:400, desc:'كحلي عميق، فضي ولمعة قمرية باردة.', preview:'theme-preview-lunar' },
            { key:'solar', name:'الشمسي', icon:'🌅', price:600, desc:'ذهبي دافئ مع وهج شمسي برتقالي أنيق.', preview:'theme-preview-solar' },
            { key:'royal_bird', name:'الطائر الملكي', icon:'🕊️', price:800, desc:'كحلي فاخر وذهبي مع روح عصفور Zono الأبيض.', preview:'theme-preview-bird' },

            { key:'electric', name:'الإلكتروني', icon:'⚡', price:900, desc:'نيون أزرق وبنفسجي، شبكة رقمية وحواف إلكترونية متوهجة.', preview:'theme-preview-electric' },
            { key:'cyber', name:'السايبر', icon:'🧬', price:1000, desc:'واجهة مستقبلية داكنة بخطوط رقمية ولمسات تركواز.', preview:'theme-preview-cyber' },
            { key:'aurora', name:'الشفق', icon:'🌌', price:1100, desc:'ألوان شفق متدرجة بين الأخضر والبنفسجي فوق ليل داكن.', preview:'theme-preview-aurora' },
            { key:'emerald', name:'الزمردي', icon:'🌿', price:1200, desc:'أخضر زمردي فاخر مع خلفية غابة ضبابية.', preview:'theme-preview-emerald' },
            { key:'ocean', name:'أعماق المحيط', icon:'🌊', price:1300, desc:'أزرق محيطي عميق مع موج وإضاءة مائية.', preview:'theme-preview-ocean' },
            { key:'ruby', name:'الياقوت', icon:'💎', price:1400, desc:'أحمر ياقوتي وأسود مخملي ولمعة فاخرة.', preview:'theme-preview-ruby' },
            { key:'desert_gold', name:'رمال الذهب', icon:'🏜️', price:1500, desc:'رمال ذهبية، نحاسي وبني دافئ بطابع صحراوي.', preview:'theme-preview-desert' },
            { key:'ice', name:'الجليدي', icon:'❄️', price:1600, desc:'أبيض جليدي وأزرق بارد بزجاج شفاف.', preview:'theme-preview-ice' },
            { key:'galaxy', name:'المجرة', icon:'🪐', price:1800, desc:'فضاء داكن ونجوم بنفسجية ولمعات كونية.', preview:'theme-preview-galaxy' },
            { key:'imperial', name:'الإمبراطوري', icon:'👑', price:2000, desc:'أسود ملكي، ذهبي عميق وإطار فاخر لأعلى فئة.', preview:'theme-preview-imperial' }
        ];
    }

    toggleCustomizationCenter() {
        const center = document.getElementById('zono-customization-center');
        if (!center) return;
        center.classList.toggle('hidden');
        if (!center.classList.contains('hidden')) {
            this.openCustomizationTab('app');
            this.renderThemeGallery();
            this.renderBirdThemes();
            this.renderNameThemes();
            this.renderAvatarFrames();
        }
    }

    openCustomizationTab(tab) {
        const tabs = ['app','bird','name','frame'];
        tabs.forEach(key => {
            document.getElementById(`zono-custom-panel-${key}`)?.classList.toggle('hidden', key !== tab);
            document.getElementById(`zono-custom-tab-${key}`)?.classList.toggle('is-active', key === tab);
        });

        if (tab === 'app') this.renderThemeGallery();
        if (tab === 'bird') this.renderBirdThemes();
        if (tab === 'name') this.renderNameThemes();
        if (tab === 'frame') this.renderAvatarFrames();
    }

    // Compatibility with older cached buttons.
    toggleNameThemes() {
        this.switchTab('settings');
        const center = document.getElementById('zono-customization-center');
        if (center) center.classList.remove('hidden');
        this.openCustomizationTab('name');
    }

    toggleBirdThemes() {
        this.switchTab('settings');
        const center = document.getElementById('zono-customization-center');
        if (center) center.classList.remove('hidden');
        this.openCustomizationTab('bird');
    }

    getAvatarFrameCatalog() {
        return [
            { key:'frame_royal', name:'الإطار الملكي', icon:'👑', price:4500, cls:'zono-frame-royal', desc:'تاج ذهبي وحلقة ملكية دوّارة حول الصورة.' },
            { key:'frame_demon', name:'الإطار الشيطاني', icon:'😈', price:4500, cls:'zono-frame-demon', desc:'لهب قرمزي داكن وحركة نابضة قوية.' },
            { key:'frame_ghost', name:'الإطار الشبحي', icon:'👻', price:4500, cls:'zono-frame-ghost', desc:'ضباب فضي متحرك وهالة شبحية ناعمة.' },
            { key:'frame_turquoise', name:'الإطار الفيروزي', icon:'🩵', price:4500, cls:'zono-frame-turquoise', desc:'حلقة فيروزية مضيئة تدور بانسيابية.' },
            { key:'frame_orbit', name:'الإطار المداري', icon:'💫', price:4500, cls:'zono-frame-orbit', desc:'حلقتان دائريتان متعاكستان مع نجمة متحركة.' }
        ];
    }

    renderAvatarFrames() {
        const grid = document.getElementById('zono-avatar-frame-grid');
        if (!grid || !this.currentUser) return;

        const base = `
            <div class="zono-cosmetic-card ${this.activeAvatarFrame === 'frame_basic' ? 'is-active' : ''}">
                <div class="zono-frame-preview">
                    <div class="zono-avatar-frame zono-frame-basic">
                        <div class="zono-frame-crown"></div>
                        <img src="${this.currentUser.avatar}" alt="">
                    </div>
                </div>
                <div class="zono-cosmetic-card-info"><b>الإطار الأساسي</b><span>مجاني</span></div>
                <button onclick="window.zonoApp.applyOwnedAvatarFrame('frame_basic')" class="zono-cosmetic-action">
                    ${this.activeAvatarFrame === 'frame_basic' ? '✓ مفعّل' : 'تطبيق'}
                </button>
            </div>`;

        grid.innerHTML = base + this.getAvatarFrameCatalog().map(f => {
            const owned = this.ownedAvatarFrames.has(f.key);
            const active = this.activeAvatarFrame === f.key;
            return `
                <div class="zono-cosmetic-card ${active ? 'is-active' : ''}">
                    <div class="zono-frame-preview">
                        <div class="zono-avatar-frame ${f.cls}">
                            <div class="zono-frame-crown"></div>
                            <img src="${this.currentUser.avatar}" alt="">
                        </div>
                    </div>
                    <div class="zono-cosmetic-card-info"><b>${f.icon} ${f.name}</b><span>${f.price.toLocaleString('en-US')} 🌾</span></div>
                    <p>${f.desc}</p>
                    <button onclick="window.zonoApp.${owned ? 'applyOwnedAvatarFrame' : 'buyAvatarFrame'}('${f.key}')" class="zono-cosmetic-action">
                        ${active ? '✓ مفعّل' : (owned ? 'تطبيق' : 'شراء بـ 4,500 بذرة')}
                    </button>
                </div>`;
        }).join('');
    }

    async buyAvatarFrame(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        const item = this.getAvatarFrameCatalog().find(x => x.key === key);
        if (!client || !item) return;

        if (Number(this.currentUser?.seeds || 0) < 4500) {
            return this.showToast('تحتاج 4,500 بذرة لشراء هذا الإطار', 'error');
        }

        try {
            const { error } = await client.rpc('zono_buy_avatar_frame', { p_frame_key:key });
            if (error) throw error;

            this.ownedAvatarFrames.add(key);
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            await this.applyOwnedAvatarFrame(key);
        } catch (e) {
            this.showToast(e.message || 'تعذر شراء إطار الصورة', 'error');
        }
    }

    async applyOwnedAvatarFrame(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client) return;
        try {
            const { error } = await client.rpc('zono_apply_avatar_frame', { p_frame_key:key });
            if (error) throw error;

            this.activeAvatarFrame = key;
            this.applyAvatarFrame(key);
            this.renderAvatarFrames();
            this.showToast('تم تطبيق إطار الصورة', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تطبيق الإطار', 'error');
        }
    }

    getAvatarFrameClass(key = this.activeAvatarFrame) {
        return this.getAvatarFrameCatalog().find(x => x.key === key)?.cls || 'zono-frame-basic';
    }

    applyAvatarFrame(key) {
        this.activeAvatarFrame = key || 'frame_basic';
        const cls = this.getAvatarFrameClass();

        const profile = document.getElementById('profile-avatar-frame');
        if (profile) {
            [...profile.classList].filter(c => c.startsWith('zono-frame-')).forEach(c => profile.classList.remove(c));
            profile.classList.add('zono-avatar-frame', cls);
        }
    }

    avatarFrameHTML(sizeClass = 'zono-chat-avatar') {
        const avatar = this.currentUser?.avatar || '';
        return `<div class="zono-avatar-frame ${this.getAvatarFrameClass()} ${sizeClass}">
            <div class="zono-frame-crown"></div>
            <img src="${avatar}" alt="">
        </div>`;
    }

    getNameThemeCatalog() {
        return [
            { key:'celestial', name:'السماوي', icon:'☁️', price:1000, cls:'zono-name-celestial', desc:'كبسولة سماوية مضيئة بهالة زرقاء.' },
            { key:'royal', name:'الملكي', icon:'👑', price:2000, cls:'zono-name-royal', desc:'ذهبي ملكي مع تاج وحواف فاخرة.' },
            { key:'legendary', name:'الأسطوري', icon:'⚜️', price:3000, cls:'zono-name-legendary', desc:'أرجواني أسطوري بلمعة قوية.' },
            { key:'emerald_name', name:'الزمردي', icon:'💚', price:4000, cls:'zono-name-emerald', desc:'زمرد داكن مع وهج أخضر.' },
            { key:'crimson_name', name:'القرمزي', icon:'🔴', price:5000, cls:'zono-name-crimson', desc:'أحمر قرمزي بلمسة نارية.' },
            { key:'electric_name', name:'الإلكتروني', icon:'⚡', price:6000, cls:'zono-name-electric', desc:'نيون إلكتروني أزرق وبنفسجي.' },
            { key:'aurora_name', name:'الشفق', icon:'🌌', price:7000, cls:'zono-name-aurora', desc:'تدرج شفق سماوي وبنفسجي.' },
            { key:'dragon_name', name:'التنين', icon:'🐉', price:8000, cls:'zono-name-dragon', desc:'داكن قوي مع أطراف نارية.' },
            { key:'phantom_name', name:'الشبح', icon:'👻', price:9000, cls:'zono-name-phantom', desc:'ضباب فضي وهالة خفية.' },
            { key:'imperial_name', name:'الإمبراطوري', icon:'🏆', price:10000, cls:'zono-name-imperial', desc:'أعلى فئة: أسود وذهبي ملكي.' }
        ];
    }

    getBirdThemeCatalog() {
        return [
            { key:'bird_ember', name:'العنقاء النارية', icon:'🔥', price:500, skin:'crimson_phoenix', cls:'bird-theme-ember', sound:'ember' },
            { key:'bird_frost', name:'الصقر الجليدي', icon:'❄️', price:1000, skin:'royal_blue', cls:'bird-theme-frost', sound:'frost' },
            { key:'bird_storm', name:'طائر العاصفة', icon:'⚡', price:1500, skin:'obsidian_gold', cls:'bird-theme-storm', sound:'storm' },
            { key:'bird_moon', name:'طائر القمر', icon:'🌙', price:2000, skin:'ivory_cockatiel', cls:'bird-theme-moon', sound:'moon' },
            { key:'bird_sun', name:'طائر الشمس', icon:'☀️', price:2500, skin:'emerald', cls:'bird-theme-sun', sound:'sun' },
            { key:'bird_neon', name:'الطائر الإلكتروني', icon:'🧬', price:3000, skin:'royal_blue', cls:'bird-theme-neon', sound:'neon' },
            { key:'bird_phantom', name:'الطائر الشبح', icon:'👻', price:3500, skin:'ivory_cockatiel', cls:'bird-theme-phantom', sound:'phantom' },
            { key:'bird_dragon', name:'جناح التنين', icon:'🐉', price:4000, skin:'crimson_phoenix', cls:'bird-theme-dragon', sound:'dragon' },
            { key:'bird_royal', name:'الطائر الملكي', icon:'👑', price:4500, skin:'obsidian_gold', cls:'bird-theme-royal', sound:'royal' },
            { key:'bird_celestial', name:'الطائر السماوي', icon:'🌌', price:5000, skin:'classic_gold', cls:'bird-theme-celestial', sound:'celestial' }
        ];
    }

    async loadCosmeticThemeState() {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client || !this.currentUser) return;

        try {
            const { data, error } = await client.rpc('zono_cosmetic_theme_state');
            if (error) throw error;

            this.activeNameTheme = data?.active_name_theme || this.currentUser.activeNameTheme || 'basic';
            this.activeBirdTheme = data?.active_bird_theme || this.currentUser.activeBirdTheme || 'bird_basic';
            this.ownedNameThemes = new Set(Array.isArray(data?.owned_name_themes) ? data.owned_name_themes : []);
            this.ownedBirdThemes = new Set(Array.isArray(data?.owned_bird_themes) ? data.owned_bird_themes : []);
            this.activeAvatarFrame = data?.active_avatar_frame || this.currentUser.activeAvatarFrame || 'frame_basic';
            this.ownedAvatarFrames = new Set(Array.isArray(data?.owned_avatar_frames) ? data.owned_avatar_frames : []);

            this.applyNameTheme(this.activeNameTheme);
            this.applyBirdTheme(this.activeBirdTheme, false);
            this.applyAvatarFrame(this.activeAvatarFrame);
        } catch (_) {
            this.activeNameTheme = this.currentUser.activeNameTheme || 'basic';
            this.activeBirdTheme = this.currentUser.activeBirdTheme || 'bird_basic';
            this.activeAvatarFrame = this.currentUser.activeAvatarFrame || 'frame_basic';
            this.applyNameTheme(this.activeNameTheme);
            this.applyBirdTheme(this.activeBirdTheme, false);
            this.applyAvatarFrame(this.activeAvatarFrame);
        }
    }

    toggleNameThemes() {
        const el = document.getElementById('zono-name-theme-gallery');
        if (!el) return;
        el.classList.toggle('hidden');
        this.renderNameThemes();
    }

    toggleBirdThemes() {
        const el = document.getElementById('zono-bird-theme-gallery');
        if (!el) return;
        el.classList.toggle('hidden');
        this.renderBirdThemes();
    }

    renderNameThemes() {
        const grid = document.getElementById('zono-name-theme-grid');
        if (!grid || !this.currentUser) return;

        const base = `
            <div class="zono-cosmetic-card">
                <div class="zono-name-preview"><span class="zono-name-capsule zono-name-basic">${this.escapeHtml(this.currentUser.displayName)}</span></div>
                <div class="zono-cosmetic-card-info"><b>الأساسي</b><span>مجاني</span></div>
                <button onclick="window.zonoApp.applyOwnedNameTheme('basic')" class="zono-cosmetic-action">${this.activeNameTheme === 'basic' ? '✓ مفعّل' : 'تطبيق'}</button>
            </div>`;

        grid.innerHTML = base + this.getNameThemeCatalog().map(t => {
            const owned = this.ownedNameThemes.has(t.key);
            const active = this.activeNameTheme === t.key;
            return `
                <div class="zono-cosmetic-card ${active ? 'is-active' : ''}">
                    <div class="zono-name-preview"><span class="zono-name-capsule ${t.cls}">${t.icon} ${this.escapeHtml(this.currentUser.displayName)}</span></div>
                    <div class="zono-cosmetic-card-info"><b>${t.name}</b><span>${t.price.toLocaleString('en-US')} 🪶</span></div>
                    <p>${t.desc}</p>
                    <button onclick="window.zonoApp.${owned ? 'applyOwnedNameTheme' : 'buyNameTheme'}('${t.key}')" class="zono-cosmetic-action">
                        ${active ? '✓ مفعّل' : (owned ? 'تطبيق' : `شراء بـ ${t.price.toLocaleString('en-US')} ريشة`)}
                    </button>
                </div>`;
        }).join('');
    }

    async buyNameTheme(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        const theme = this.getNameThemeCatalog().find(x => x.key === key);
        if (!client || !theme) return;
        if (Number(this.currentUser?.feathers || 0) < theme.price) {
            return this.showToast(`تحتاج ${theme.price.toLocaleString('en-US')} ريشة`, 'error');
        }
        try {
            const { error } = await client.rpc('zono_buy_name_theme', { p_theme_key:key });
            if (error) throw error;
            this.ownedNameThemes.add(key);
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            await this.applyOwnedNameTheme(key);
        } catch (e) {
            this.showToast(e.message || 'تعذر شراء ثيم الاسم', 'error');
        }
    }

    async applyOwnedNameTheme(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client) return;
        try {
            const { error } = await client.rpc('zono_apply_name_theme', { p_theme_key:key });
            if (error) throw error;
            this.activeNameTheme = key;
            this.applyNameTheme(key);
            this.renderNameThemes();
            this.showToast('تم تطبيق ثيم الاسم', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تطبيق ثيم الاسم', 'error');
        }
    }

    applyNameTheme(key) {
        const profile = document.getElementById('profile-display-name');
        const header = document.getElementById('header-user-name');
        const found = this.getNameThemeCatalog().find(x => x.key === key);
        const cls = found?.cls || 'zono-name-basic';

        [profile, header].forEach(el => {
            if (!el) return;
            [...el.classList].filter(c => c.startsWith('zono-name-')).forEach(c => el.classList.remove(c));
            el.classList.add('zono-name-live', cls);
        });
    }

    getNameThemeClass(key = this.activeNameTheme) {
        return this.getNameThemeCatalog().find(x => x.key === key)?.cls || 'zono-name-basic';
    }

    renderBirdThemes() {
        const paidGrid = document.getElementById('zono-bird-theme-grid');
        const ownedGrid = document.getElementById('zono-owned-bird-theme-grid');
        if (!paidGrid || !ownedGrid || !this.currentUser) return;

        const items = this.getStoreItems();
        const inventory = new Set(this.currentUser.inventory || []);

        ownedGrid.innerHTML = items.filter(x => inventory.has(x.id)).map(item => {
            const pseudoKey = `owned:${item.id}`;
            const active = this.activeBirdTheme === pseudoKey;
            return `
                <div class="zono-cosmetic-card ${active ? 'is-active' : ''}">
                    <div class="zono-bird-theme-preview owned-bird-preview">${item.icon}</div>
                    <div class="zono-cosmetic-card-info"><b>${item.name}</b><span>مفتوح مجاناً</span></div>
                    <button onclick="window.zonoApp.applyOwnedBirdSkinTheme('${item.id}')" class="zono-cosmetic-action">${active ? '✓ مفعّل' : 'تطبيق'}</button>
                </div>`;
        }).join('') || '<div class="zono-empty-cosmetic">لا توجد طيور مشتراة بعد.</div>';

        paidGrid.innerHTML = this.getBirdThemeCatalog().map(t => {
            const owned = this.ownedBirdThemes.has(t.key);
            const active = this.activeBirdTheme === t.key;
            return `
                <div class="zono-cosmetic-card ${active ? 'is-active' : ''}">
                    <div class="zono-bird-theme-preview ${t.cls}">${t.icon}</div>
                    <div class="zono-cosmetic-card-info"><b>${t.name}</b><span>${t.price.toLocaleString('en-US')} 🌾</span></div>
                    <button onclick="window.zonoApp.${owned ? 'applyOwnedBirdTheme' : 'buyBirdTheme'}('${t.key}')" class="zono-cosmetic-action">
                        ${active ? '✓ مفعّل' : (owned ? 'تطبيق' : `شراء بـ ${t.price.toLocaleString('en-US')} بذرة`)}
                    </button>
                </div>`;
        }).join('');
    }

    async buyBirdTheme(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        const theme = this.getBirdThemeCatalog().find(x => x.key === key);
        if (!client || !theme) return;
        if (Number(this.currentUser?.seeds || 0) < theme.price) {
            return this.showToast(`تحتاج ${theme.price.toLocaleString('en-US')} بذرة`, 'error');
        }
        try {
            const { error } = await client.rpc('zono_buy_bird_theme', { p_theme_key:key });
            if (error) throw error;
            this.ownedBirdThemes.add(key);
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            await this.applyOwnedBirdTheme(key);
        } catch (e) {
            this.showToast(e.message || 'تعذر شراء ثيم الطائر', 'error');
        }
    }

    async applyOwnedBirdTheme(key) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client) return;
        try {
            const { error } = await client.rpc('zono_apply_bird_theme', { p_theme_key:key });
            if (error) throw error;
            this.activeBirdTheme = key;
            this.applyBirdTheme(key, true);
            this.renderBirdThemes();
            this.showToast('تم تطبيق ثيم الطائر', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تطبيق ثيم الطائر', 'error');
        }
    }

    async applyOwnedBirdSkinTheme(skinId) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client) return;
        try {
            const { error } = await client.rpc('zono_apply_owned_bird_skin_theme', { p_skin_id:skinId });
            if (error) throw error;
            this.activeBirdTheme = `owned:${skinId}`;
            this.applyBirdTheme(this.activeBirdTheme, true);
            this.renderBirdThemes();
        } catch (e) {
            this.showToast(e.message || 'تعذر تطبيق ثيم الطائر', 'error');
        }
    }

    applyBirdTheme(key, playSound = false) {
        const stage = document.getElementById('zono-bird-theme-stage');
        const clock = document.getElementById('zono-bird-theme-clock');
        if (!stage) return;

        [...stage.classList].filter(c => c.startsWith('bird-theme-')).forEach(c => stage.classList.remove(c));
        if (clock) [...clock.classList].filter(c => c.startsWith('bird-theme-')).forEach(c => clock.classList.remove(c));

        let skin = this.currentUser?.activeBird || 'classic_gold';
        let cls = 'bird-theme-basic';
        let sound = 'basic';

        if (String(key).startsWith('owned:')) {
            skin = String(key).split(':')[1] || skin;
            cls = `bird-theme-owned-${skin.replace(/[^a-z0-9_-]/gi,'')}`;
        } else {
            const theme = this.getBirdThemeCatalog().find(x => x.key === key);
            if (theme) {
                skin = theme.skin;
                cls = theme.cls;
                sound = theme.sound;
            }
        }

        stage.classList.add(cls);
        if (clock) clock.classList.add(cls);
        document.documentElement.setAttribute('data-bird-theme', key);

        if (this.birdEngine?.setSkin) {
            try { this.birdEngine.setSkin(skin); } catch (_) {}
        }

        if (playSound) this.playBirdThemeSound(sound);
    }

    playBirdThemeSound(type='basic') {
        if (!this.soundEnabled) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const map = {
                basic:[620,'sine'], ember:[390,'sawtooth'], frost:[880,'sine'], storm:[180,'square'],
                moon:[520,'triangle'], sun:[740,'sine'], neon:[980,'square'], phantom:[300,'sine'],
                dragon:[140,'sawtooth'], royal:[660,'triangle'], celestial:[1040,'sine']
            };
            const cfg = map[type] || map.basic;
            osc.type = cfg[1];
            osc.frequency.setValueAtTime(cfg[0], ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(Math.max(80,cfg[0]*1.35), ctx.currentTime + .22);
            gain.gain.setValueAtTime(.035, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .28);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + .3);
            setTimeout(() => ctx.close().catch(()=>{}), 500);
        } catch (_) {}
    }

    toggleBirdFlightThemed() {
        const theme = this.getBirdThemeCatalog().find(x => x.key === this.activeBirdTheme);
        this.playBirdThemeSound(theme?.sound || 'basic');
        const stage = document.getElementById('zono-bird-theme-stage');
        if (stage) {
            stage.classList.remove('zono-theme-flight-burst');
            void stage.offsetWidth;
            stage.classList.add('zono-theme-flight-burst');
        }
        if (window.zonoBirdEngine?.toggleFlight) window.zonoBirdEngine.toggleFlight();
    }

    applyTheme(theme) {
        const valid = new Set(this.getThemeCatalog().map(x => x.key));
        const safeTheme = valid.has(theme) ? theme : 'classic_night';
        this.theme = safeTheme;
        document.documentElement.setAttribute('data-theme', safeTheme);
        localStorage.setItem('zono_theme', safeTheme);
        this.renderThemeGallery();
    }

    async loadThemeState() {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client || !this.currentUser) {
            this.applyTheme(this.theme);
            return;
        }

        try {
            const { data, error } = await client.rpc('zono_theme_state');
            if (error) throw error;

            const owned = Array.isArray(data?.owned_themes) ? data.owned_themes : [];
            this.ownedThemes = new Set(['classic_night','daylight', ...owned]);
            this.readReceiptsEnabled = data?.read_receipts_enabled !== false;
            this.applyTheme(data?.active_theme || this.currentUser.activeTheme || this.theme);
        } catch (_) {
            this.ownedThemes = new Set(['classic_night','daylight']);
            this.readReceiptsEnabled = this.currentUser?.readReceiptsEnabled !== false;
            this.applyTheme(this.currentUser?.activeTheme || this.theme);
        }
    }

    toggleThemeGallery() {
        const gallery = document.getElementById('zono-theme-gallery');
        if (!gallery) return;
        gallery.classList.toggle('hidden');
        this.renderThemeGallery();
    }

    renderThemeGallery() {
        const grid = document.getElementById('zono-theme-grid');
        if (!grid) return;

        grid.innerHTML = this.getThemeCatalog().map(t => {
            const owned = t.price === 0 || this.ownedThemes?.has(t.key);
            const active = this.theme === t.key;
            const actionText = active ? '✓ مفعّل' : (owned ? 'تطبيق' : `شراء ${t.price} ريشة`);
            const actionClass = active ? 'zono-theme-active-btn' : (owned ? 'zono-theme-apply-btn' : 'zono-theme-buy-btn');

            return `
                <div class="zono-theme-card ${active ? 'is-active' : ''}">
                    <div class="zono-theme-preview ${t.preview}"><span>${t.icon}</span></div>
                    <div class="zono-theme-card-body">
                        <div class="flex items-center justify-between gap-2">
                            <strong class="text-xs text-stone-100">${t.icon} ${t.name}</strong>
                            <span class="zono-theme-price ${t.price === 0 ? 'free' : ''}">${t.price === 0 ? 'مجاني' : `${t.price} 🪶`}</span>
                        </div>
                        <p class="text-[10px] text-stone-400 mt-1 leading-5">${t.desc}</p>
                        <button ${active ? 'disabled' : ''} onclick="window.zonoApp.handleThemeAction('${t.key}')" class="zono-theme-action ${actionClass}">
                            ${actionText}
                        </button>
                    </div>
                </div>`;
        }).join('');
    }

    async handleThemeAction(themeKey) {
        if (!this.currentUser) return this.showAuthModal();

        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        const theme = this.getThemeCatalog().find(x => x.key === themeKey);
        if (!client || !theme) return;

        try {
            if (theme.price > 0 && !this.ownedThemes.has(themeKey)) {
                if (Number(this.currentUser.feathers || 0) < theme.price) {
                    return this.showToast(`تحتاج ${theme.price} ريشة لشراء هذا الثيم`, 'error');
                }

                const { error: buyError } = await client.rpc('zono_buy_theme', { p_theme_key: themeKey });
                if (buyError) throw buyError;

                this.ownedThemes.add(themeKey);
                await window.zonoAuth.loadProfile(window.zonoAuth.user);
                await this.syncUserFromSupabase();
                this.showToast(`تم شراء ثيم ${theme.name} بنجاح`, 'success');
            }

            const { error } = await client.rpc('zono_apply_theme', { p_theme_key: themeKey });
            if (error) throw error;

            this.applyTheme(themeKey);
            if (this.currentUser) this.currentUser.activeTheme = themeKey;
            this.showToast(`تم تطبيق ثيم ${theme.name}`, 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تطبيق الثيم', 'error');
        }
    }

    toggleTheme() {
        this.toggleThemeGallery();
    }

    async toggleReadReceipts() {
        const el = document.getElementById('setting-read-receipts-toggle');
        const enabled = !!el?.checked;
        const client = window.zunoBackend?.client || window.zunoAuth?.client;

        if (!client || !this.currentUser) {
            this.readReceiptsEnabled = enabled;
            return;
        }

        try {
            const { error } = await client.rpc('zono_set_read_receipts', { p_enabled: enabled });
            if (error) throw error;

            this.readReceiptsEnabled = enabled;
            this.currentUser.readReceiptsEnabled = enabled;
            this.showToast(enabled ? 'تم إظهار إشعارات القراءة' : 'تم إخفاء إشعارات القراءة', 'success');
        } catch (e) {
            if (el) el.checked = !enabled;
            this.showToast(e.message || 'تعذر تحديث إعداد القراءة', 'error');
        }
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

        const soundSetting = document.getElementById('setting-sound-toggle');
        if (soundSetting) soundSetting.checked = this.soundEnabled;

        const receiptsSetting = document.getElementById('setting-read-receipts-toggle');
        if (receiptsSetting) receiptsSetting.checked = this.readReceiptsEnabled !== false;

        this.updateHeaderUI();
        this.updateProfileUI();
        this.renderStore();
        this.renderThemeGallery();
        this.renderNameThemes();
        this.renderBirdThemes();
        this.applyNameTheme(this.activeNameTheme);
        this.applyBirdTheme(this.activeBirdTheme, false);
        this.applyAvatarFrame(this.activeAvatarFrame);
        this.renderAvatarFrames();
        this.refreshVerificationBadge();
        this.loadRooms();
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

    showBanCapsule(reason = '', until = null) {
        const el = document.getElementById('auth-message');
        if (!el) return;

        const reasonText = String(reason || 'لم يتم تحديد سبب الحظر.');
        let timeText = '';
        if (until) {
            const untilMs = new Date(until).getTime();
            if (Number.isFinite(untilMs) && untilMs > Date.now()) {
                const mins = Math.max(1, Math.ceil((untilMs - Date.now()) / 60000));
                timeText = `حظر مؤقت — المتبقي تقريباً ${mins} دقيقة`;
            }
        }

        el.className = 'mt-4';
        el.innerHTML = `
            <div class="mx-auto max-w-sm">
                <div class="flex items-center justify-center gap-2">
                    <div class="px-4 py-2 rounded-full border border-red-500/40 bg-red-500/10 text-red-300 text-xs font-black shadow-lg">
                        ⛔ الحساب محظور
                    </div>
                    <button id="ban-reason-toggle" type="button"
                        class="w-8 h-8 rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-300 text-sm font-black"
                        aria-label="سبب الحظر">؟</button>
                </div>
                <div id="ban-reason-box" class="hidden mt-3 rounded-2xl border border-stone-700 bg-stone-900/90 px-4 py-3 text-center">
                    <div class="text-[10px] text-stone-500 mb-1">سبب الحظر</div>
                    <div id="ban-reason-text" class="text-xs font-bold text-stone-200"></div>
                    <div id="ban-time-text" class="text-[10px] text-red-300 mt-2"></div>
                </div>
            </div>
        `;

        const reasonEl = document.getElementById('ban-reason-text');
        const timeEl = document.getElementById('ban-time-text');
        const box = document.getElementById('ban-reason-box');
        const toggle = document.getElementById('ban-reason-toggle');

        if (reasonEl) reasonEl.textContent = reasonText;
        if (timeEl) timeEl.textContent = timeText;
        if (toggle && box) {
            toggle.addEventListener('click', () => box.classList.toggle('hidden'));
        }
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
            const blocked = await this.enforceCurrentUserBan();
            if (blocked) return;
            await this.syncUserFromSupabase();
            await this.loadThemeState();
            await this.loadCosmeticThemeState();
            this.showMainApp();
            await this.loadNotifications(true);
            this.startNotificationWatcher();
            this.startBanWatcher();
            if (window.zonoAudio) window.zonoAudio.playChirp();
            this.showToast(`مرحباً بك يا ${this.currentUser.displayName}!`, 'success');
        } catch (e) {
            if (e?.isBanned) {
                this.showBanCapsule(e.banReason || '', e.bannedUntil || null);
            } else {
                this.setAuthMessage(e.message || 'تعذر تسجيل الدخول', 'error');
            }
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
        if (this.notificationWatcher) {
            clearInterval(this.notificationWatcher);
            this.notificationWatcher = null;
        }
        if (this.banWatcher) {
            clearInterval(this.banWatcher);
            this.banWatcher = null;
        }
        this.notificationsPrimed = false;
        this.lastNotificationId = 0;

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
        document.body.classList.toggle('zono-counter-mode', tabId === 'counter');

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
        const walletIqdBalance = document.getElementById('zono-wallet-iqd-balance');
        const dailySeedsStat = document.getElementById('bird-daily-seeds-stat');
        const dailySeedsTotalEl = document.getElementById('bird-daily-seeds-total');
        const dailyFeathersTotalEl = document.getElementById('bird-daily-feathers-total');

        if (profileName) profileName.textContent = this.currentUser.displayName;
        if (profileUser) profileUser.textContent = `ID: ${this.currentUser.username}`;
        if (profileBio) profileBio.textContent = this.currentUser.bio;
        if (profileAvatar) profileAvatar.src = this.currentUser.avatar;
        if (profileBadge) {
            profileBadge.textContent = '🛡️ توثيق الحساب';
            profileBadge.classList.remove('zono-agent-badge', 'zono-developer-badge');
        }
        const transferCard = document.getElementById('seed-transfer-card');
        if (transferCard) transferCard.classList.toggle('hidden', !['developer','agent'].includes(this.currentUser.role));
        const developerBanCard = document.getElementById('developer-ban-card');
        if (developerBanCard) developerBanCard.classList.toggle('hidden', this.currentUser.role !== 'developer');
        const developerUnbanCard = document.getElementById('developer-unban-card');
        if (developerUnbanCard) developerUnbanCard.classList.toggle('hidden', this.currentUser.role !== 'developer');
        const developerQueryCard = document.getElementById('developer-query-card');
        if (developerQueryCard) developerQueryCard.classList.toggle('hidden', this.currentUser.role !== 'developer');
        const developerAdminCard = document.getElementById('developer-admin-card');
        if (developerAdminCard) developerAdminCard.classList.toggle('hidden', this.currentUser.role !== 'developer');
        const agencyRequestCard = document.getElementById('agency-request-card');
        if (agencyRequestCard) agencyRequestCard.classList.toggle('hidden', ['agent','developer'].includes(this.currentUser.role));
        const agentBadge = document.getElementById('profile-agent-badge');
        if (agentBadge) {
            const isAgent = this.currentUser.role === 'agent';
            agentBadge.classList.toggle('hidden', !isAgent);
            agentBadge.textContent = isAgent ? '✓ وكيل معتمد' : '';
        }
        const walletWithdrawBtn = document.getElementById('zono-wallet-withdraw-btn');
        if (walletWithdrawBtn) walletWithdrawBtn.classList.remove('hidden');
        if (profileHours) profileHours.textContent = `${this.currentUser.stats.flightHours} س`;
        if (profileRooms) profileRooms.textContent = this.currentUser.stats.roomsCreated;
        if (profileMsgs) profileMsgs.textContent = this.currentUser.stats.messagesSent;
        if (profileFeathers) profileFeathers.textContent = `${this.currentUser.feathers} ريشة`;
        if (profileSeeds) profileSeeds.textContent = `${this.currentUser.seeds} بذرة`;
        if (walletIqdBalance) walletIqdBalance.textContent = Number(this.currentUser.seeds || 0).toLocaleString('en-US');
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

    async getVerificationStatus() {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client || !this.currentUser) return { verified: false };
        try {
            const { data, error } = await client.rpc('zono_verification_status');
            if (error) throw error;
            return data || { verified: false };
        } catch (_) { return { verified: false }; }
    }

    async openVerification() {
        if (!this.currentUser) return this.showAuthModal();
        this.switchTab('profile');
        const panel=document.getElementById('zono-verification-panel'), setup=document.getElementById('zono-verification-setup'), lock=document.getElementById('zono-verification-lock'), view=document.getElementById('zono-verification-view');
        if (!panel || !setup || !lock || !view) return;
        panel.classList.remove('hidden'); setup.classList.add('hidden'); lock.classList.add('hidden'); view.classList.add('hidden');
        const status=await this.getVerificationStatus();
        (status.verified ? lock : setup).classList.remove('hidden');
        setTimeout(()=>panel.scrollIntoView({behavior:'smooth',block:'start'}),80);
    }

    closeVerification() {
        ['zono-verification-panel','zono-verification-setup','zono-verification-lock','zono-verification-view'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
        const el=document.getElementById('verify-unlock-code'); if(el) el.value='';
    }

    async saveAccountVerification() {
        const client=window.zunoBackend?.client || window.zunoAuth?.client;
        const fullName=String(document.getElementById('verify-full-name')?.value||'').trim();
        const birthDate=String(document.getElementById('verify-birth-date')?.value||'').trim();
        const phone=String(document.getElementById('verify-phone')?.value||'').replace(/\D/g,'');
        const code=String(document.getElementById('verify-code')?.value||'').replace(/\D/g,'');
        const confirmCode=String(document.getElementById('verify-code-confirm')?.value||'').replace(/\D/g,'');
        if(fullName.length<3) return this.showToast('أدخل الاسم الكامل','error');
        if(!birthDate) return this.showToast('أدخل تاريخ الميلاد','error');
        if(phone.length<10||phone.length>15) return this.showToast('رقم الهاتف غير صحيح','error');
        if(!/^\d{4,8}$/.test(code)) return this.showToast('رمز التوثيق يجب أن يكون من 4 إلى 8 أرقام','error');
        if(code!==confirmCode) return this.showToast('رمزا التوثيق غير متطابقين','error');
        try {
            const {error}=await client.rpc('zono_create_account_verification',{p_full_name:fullName,p_birth_date:birthDate,p_phone:phone,p_verification_code:code});
            if(error) throw error;
            this.showToast('تم حفظ وثيقة الحساب وتفعيل التوثيق','success');
            await this.refreshVerificationBadge(); this.closeVerification();
        } catch(e){ this.showToast(e.message||'تعذر حفظ التوثيق','error'); }
    }

    async unlockAccountVerification() {
        const client=window.zunoBackend?.client || window.zunoAuth?.client;
        const code=String(document.getElementById('verify-unlock-code')?.value||'').replace(/\D/g,'');
        if(!/^\d{4,8}$/.test(code)) return this.showToast('أدخل رمز التوثيق الصحيح','error');
        try {
            const {data,error}=await client.rpc('zono_unlock_account_verification',{p_verification_code:code});
            if(error) throw error;
            document.getElementById('verify-view-name').textContent=data.full_name||'—';
            document.getElementById('verify-view-birth').textContent=data.birth_date||'—';
            document.getElementById('verify-view-phone').textContent=data.phone||'—';
            document.getElementById('zono-verification-lock')?.classList.add('hidden');
            document.getElementById('zono-verification-view')?.classList.remove('hidden');
            const el=document.getElementById('verify-unlock-code'); if(el) el.value='';
        } catch(e){ this.showToast(e.message||'رمز التوثيق غير صحيح','error'); }
    }

    async refreshVerificationBadge() {
        const status = await this.getVerificationStatus();
        const badge = document.getElementById('profile-badge-pill');

        if (badge) {
            badge.textContent = status.verified ? '✓ حساب موثّق' : '🛡️ توثيق الحساب';
            badge.classList.toggle('is-verified-account', !!status.verified);
        }

        return !!status.verified;
    }

    async openWallet() {
        if (!this.currentUser) return this.showAuthModal();

        const panel = document.getElementById('zono-wallet-panel');
        if (!panel) return;

        this.switchTab('profile');
        this.updateProfileUI();

        panel.classList.remove('hidden');

        const admin = document.getElementById('zono-withdrawal-admin');
        if (admin) admin.classList.add('hidden');

        const withdrawBtn = document.getElementById('zono-wallet-withdraw-btn');
        const canWithdraw = !!this.currentUser;
        if (withdrawBtn) withdrawBtn.classList.toggle('hidden', !canWithdraw);
        if (!canWithdraw) document.getElementById('zono-wallet-withdraw-options')?.classList.add('hidden');

        await this.loadWithdrawalHistory();

        setTimeout(() => {
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
    }

    closeWallet() {
        const panel = document.getElementById('zono-wallet-panel');
        const options = document.getElementById('zono-wallet-withdraw-options');
        const fib = document.getElementById('zono-wallet-method-fib');
        const qi = document.getElementById('zono-wallet-method-qi');

        if (panel) panel.classList.add('hidden');
        if (options) options.classList.add('hidden');
        if (fib) fib.classList.add('hidden');
        if (qi) qi.classList.add('hidden');
    }

    toggleWalletWithdraw() {
        const options = document.getElementById('zono-wallet-withdraw-options');
        if (!options) return;
        options.classList.toggle('hidden');
    }

    selectWalletMethod(method) {
        const fib = document.getElementById('zono-wallet-method-fib');
        const qi = document.getElementById('zono-wallet-method-qi');

        if (fib) fib.classList.toggle('hidden', method !== 'fib');
        if (qi) qi.classList.toggle('hidden', method !== 'qi');
    }

    previewWithdrawAmount(method) {
        const input = document.getElementById(method === 'fib' ? 'fib-seeds-amount' : 'qi-seeds-amount');
        const preview = document.getElementById(method === 'fib' ? 'fib-withdraw-preview' : 'qi-withdraw-preview');
        if (!input || !preview) return;

        const amount = Math.max(0, Number(String(input.value || '').replace(/\D/g, '')) || 0);
        preview.textContent = `يعادل: ${amount.toLocaleString('en-US')} د.ع`;
        preview.classList.toggle('text-red-400', amount > 0 && amount < 15000);
        preview.classList.toggle('text-emerald-300', amount >= 15000);
    }

    async submitWithdrawal(method) {
        if (!this.currentUser) return this.showAuthModal();

        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client) return this.showToast('تعذر الاتصال بالخادم', 'error');
        if (!this.currentUser) {
            return this.showToast('سحب البذور متاح للوكلاء المعتمدين فقط', 'error');
        }

        const isVerified = await this.refreshVerificationBadge();
        if (!isVerified) return this.showToast('يجب توثيق الحساب أولاً قبل سحب البذور', 'error');

        const isFib = method === 'fib';
        const accountName = String(document.getElementById(isFib ? 'fib-account-name' : 'qi-account-name')?.value || '').trim();
        const amount = Number(String(document.getElementById(isFib ? 'fib-seeds-amount' : 'qi-seeds-amount')?.value || '').replace(/\D/g, ''));
        const verificationCode = String(document.getElementById(isFib ? 'fib-verification-code' : 'qi-verification-code')?.value || '').replace(/\D/g, '');

        let fibPhone = '';
        let qiPhone11 = '';
        let qiAccount = '';

        if (isFib) {
            fibPhone = String(document.getElementById('fib-phone')?.value || '').replace(/\D/g, '');
            if (accountName.length < 2) return this.showToast('أدخل اسم صاحب حساب FIB', 'error');
            if (fibPhone.length < 10 || fibPhone.length > 15) return this.showToast('رقم هاتف FIB غير صحيح', 'error');
        } else {
            qiPhone11 = String(document.getElementById('qi-phone-11')?.value || '').replace(/\D/g, '');
            qiAccount = String(document.getElementById('qi-account-number')?.value || '').replace(/\D/g, '');
            if (accountName.length < 2) return this.showToast('أدخل اسم صاحب بطاقة Qi', 'error');
            if (qiPhone11.length !== 11) return this.showToast('يجب أن يكون الرقم مكوناً من 11 رقم', 'error');
            if (qiAccount.length < 4) return this.showToast('أدخل رقم حساب Qi الصحيح', 'error');
        }

        if (!Number.isInteger(amount) || amount < 15000) {
            return this.showToast('الحد الأدنى للسحب 15,000 بذرة', 'error');
        }

        if (amount > Number(this.currentUser.seeds || 0)) {
            return this.showToast('رصيد البذور غير كافٍ', 'error');
        }

        if (verificationCode.length < 4 || verificationCode.length > 8) {
            return this.showToast('رمز التوثيق يجب أن يكون من 4 إلى 8 أرقام', 'error');
        }

        try {
            const { data, error } = await client.rpc('zono_withdrawal_submit_v2', {
                p_method: method,
                p_account_name: accountName,
                p_fib_phone: fibPhone || null,
                p_qi_phone_11: qiPhone11 || null,
                p_qi_account: qiAccount || null,
                p_amount_seeds: amount,
                p_verification_code: verificationCode
            });

            if (error) throw error;

            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            this.updateProfileUI();

            ['fib-account-name','fib-phone','fib-seeds-amount','fib-verification-code',
             'qi-account-name','qi-phone-11','qi-account-number','qi-seeds-amount','qi-verification-code']
                .forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });

            this.previewWithdrawAmount('fib');
            this.previewWithdrawAmount('qi');
            await this.loadWithdrawalHistory();

            this.showToast(`تم إنشاء طلب سحب ${amount.toLocaleString('en-US')} بذرة — قيد المعالجة`, 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر إتمام طلب السحب', 'error');
        }
    }

    async loadWithdrawalHistory() {
        const list = document.getElementById('zono-withdrawal-history-list');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || !this.currentUser) return;

        try {
            const { data, error } = await client.rpc('zono_withdrawal_my_v2');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];

            list.innerHTML = rows.length ? rows.map(row => {
                const status = String(row.status || 'pending');
                const statusText = status === 'approved' ? 'تمت الموافقة'
                    : status === 'rejected' ? 'تم الرفض'
                    : 'قيد المعالجة';

                const statusClass = status === 'approved' ? 'zono-status-approved'
                    : status === 'rejected' ? 'zono-status-rejected'
                    : 'zono-status-pending';

                const reason = status === 'rejected' && row.rejection_reason
                    ? `<div class="text-[10px] text-red-300 mt-2">السبب: ${this.escapeHtml(row.rejection_reason)}</div>`
                    : '';

                return `
                    <div class="zono-withdrawal-row">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="font-black text-xs text-stone-100">${row.method === 'fib' ? '🏦 FIB' : '💳 Qi'} — ${Number(row.amount_seeds || 0).toLocaleString('en-US')} بذرة</div>
                                <div class="text-[10px] text-stone-500 mt-1">${new Date(row.created_at).toLocaleString('ar-IQ')}</div>
                                ${reason}
                            </div>
                            <span class="zono-withdrawal-status ${statusClass}">${statusText}</span>
                        </div>
                    </div>`;
            }).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد طلبات سحب</div>';
        } catch (e) {
            list.innerHTML = '<div class="text-center text-red-400 text-xs py-4">تعذر تحميل سجل السحب</div>';
        }
    }

    async loadWithdrawalAdmin() {
        const list = document.getElementById('zono-withdrawal-admin-list');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || this.currentUser?.role !== 'developer') return;

        try {
            const { data, error } = await client.rpc('zono_withdrawal_pending_v3');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];

            list.innerHTML = rows.length ? rows.map(row => `
                <div class="zono-withdrawal-row border-emerald-500/20">
                    <div class="font-black text-xs text-stone-100">${row.method === 'fib' ? '🏦 FIB' : '💳 Qi'} — ID ${row.public_id}</div>
                    <div class="text-[10px] text-stone-300 mt-2 leading-5">
                        الاسم: ${this.escapeHtml(row.account_name || '')}<br>
                        ${row.method === 'fib'
                            ? `هاتف FIB: ${this.escapeHtml(row.fib_phone || '')}`
                            : `رقم 11: ${this.escapeHtml(row.qi_phone_11 || '')}<br>حساب Qi: ${this.escapeHtml(row.qi_account || '')}`}
                        <br>البذور: ${Number(row.amount_seeds || 0).toLocaleString('en-US')}
                        <br>القيمة: ${Number(row.amount_iqd || 0).toLocaleString('en-US')} د.ع
                    </div>
                    <div class="grid grid-cols-2 gap-2 mt-3">
                        <button onclick="window.zonoApp.reviewWithdrawal(${Number(row.id)}, 'approved')" class="zono-withdraw-approve-btn">موافقة</button>
                        <button onclick="window.zonoApp.reviewWithdrawal(${Number(row.id)}, 'rejected')" class="zono-withdraw-reject-btn">رفض</button>
                    </div>
                </div>
            `).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد طلبات قيد المعالجة</div>';
        } catch (e) {
            list.innerHTML = '<div class="text-center text-red-400 text-xs py-4">تعذر تحميل الطلبات</div>';
        }
    }

    async reviewWithdrawal(id, decision) {
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client || this.currentUser?.role !== 'developer') return;

        let reason = '';
        if (decision === 'rejected') {
            reason = window.prompt('اكتب سبب رفض طلب السحب:') || '';
            if (!reason.trim()) return this.showToast('يجب كتابة سبب الرفض', 'error');
        }

        try {
            const { data, error } = await client.rpc('zono_withdrawal_review_v2', {
                p_withdrawal_id: Number(id),
                p_decision: decision,
                p_rejection_reason: reason.trim() || null
            });
            if (error) throw error;

            await this.loadWithdrawalAdmin();
            this.showToast(decision === 'approved' ? 'تمت الموافقة على الطلب' : 'تم رفض الطلب وإرجاع البذور', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تحديث الطلب', 'error');
        }
    }


    // --- Developer Administration Hub: transfers + agencies ---
    openDeveloperAdminModal(tab = 'transfers') {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('قسم الإدارة للمطور فقط', 'error');
        }
        const modal = document.getElementById('developer-admin-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        this.switchDeveloperAdminTab(tab);
    }

    closeDeveloperAdminModal() {
        const modal = document.getElementById('developer-admin-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    switchDeveloperAdminTab(tab) {
        if (this.currentUser?.role !== 'developer') return;
        const transfers = tab === 'transfers';
        document.getElementById('developer-admin-tab-transfers')?.classList.toggle('is-active', transfers);
        document.getElementById('developer-admin-tab-agents')?.classList.toggle('is-active', !transfers);
        document.getElementById('developer-admin-transfers')?.classList.toggle('hidden', !transfers);
        document.getElementById('developer-admin-agents')?.classList.toggle('hidden', transfers);
        if (transfers) {
            this.loadDeveloperTransferRequests();
            this.loadDeveloperApprovedTransfers();
        } else {
            this.loadDeveloperAgencyRequests();
        }
    }

    async loadDeveloperTransferRequests() {
        const list = document.getElementById('developer-admin-transfer-pending-list');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || this.currentUser?.role !== 'developer') return;
        list.innerHTML = '<div class="text-center text-stone-500 text-xs py-4">جاري تحميل الطلبات...</div>';
        try {
            const { data, error } = await client.rpc('zono_withdrawal_pending_v3');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            list.innerHTML = rows.length ? rows.map(row => `
                <div class="zono-withdrawal-row border-emerald-500/20">
                    <div class="flex items-center justify-between gap-2">
                        <div class="font-black text-xs text-stone-100">ID ${Number(row.public_id || 0)} — ${this.escapeHtml(row.display_name || row.account_name || '')}</div>
                        <span class="zono-withdrawal-status zono-status-pending">قيد المعالجة</span>
                    </div>
                    <div class="text-[10px] text-stone-300 mt-2 leading-5">
                        الطريقة: ${row.method === 'fib' ? 'FIB' : 'Qi'}<br>
                        صاحب الحساب: ${this.escapeHtml(row.account_name || '')}<br>
                        ${row.method === 'fib'
                            ? `هاتف FIB: ${this.escapeHtml(row.fib_phone || '')}`
                            : `رقم 11: ${this.escapeHtml(row.qi_phone_11 || '')}<br>حساب Qi: ${this.escapeHtml(row.qi_account || '')}`}
                        <br>البذور: ${Number(row.amount_seeds || 0).toLocaleString('en-US')}
                    </div>
                    <div class="grid grid-cols-2 gap-2 mt-3">
                        <button onclick="window.zonoApp.reviewDeveloperTransfer(${Number(row.id)}, 'approved')" class="zono-withdraw-approve-btn">قبول</button>
                        <button onclick="window.zonoApp.reviewDeveloperTransfer(${Number(row.id)}, 'rejected')" class="zono-withdraw-reject-btn">رفض</button>
                    </div>
                </div>
            `).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد طلبات حوالات قيد المعالجة</div>';
        } catch (e) {
            list.innerHTML = `<div class="text-center text-red-400 text-xs py-4">${this.escapeHtml(e.message || 'تعذر تحميل الطلبات')}</div>`;
        }
    }

    async loadDeveloperApprovedTransfers() {
        const list = document.getElementById('developer-admin-transfer-approved-list');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || this.currentUser?.role !== 'developer') return;
        try {
            const { data, error } = await client.rpc('zono_withdrawal_approved_v3');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            list.innerHTML = rows.length ? rows.map(row => `
                <div class="zono-withdrawal-row border-sky-500/20">
                    <div class="flex items-center justify-between gap-2">
                        <strong class="text-xs text-stone-100">${this.escapeHtml(row.display_name || row.account_name || '')}</strong>
                        <span class="zono-withdrawal-status zono-status-approved">تم القبول</span>
                    </div>
                    <div class="text-[10px] text-stone-400 mt-1">ID ${Number(row.public_id || 0)} • ${Number(row.amount_seeds || 0).toLocaleString('en-US')} بذرة</div>
                </div>
            `).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد سحوبات مقبولة بعد</div>';
        } catch (e) {
            list.innerHTML = '<div class="text-center text-red-400 text-xs py-4">تعذر تحميل السحوبات المقبولة</div>';
        }
    }

    async reviewDeveloperTransfer(id, decision) {
        if (this.currentUser?.role !== 'developer') return;
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client) return;
        let reason = '';
        if (decision === 'rejected') {
            reason = String(window.prompt('اكتب سبب رفض طلب السحب:') || '').trim();
            if (reason.length < 3) return this.showToast('اكتب سبب الرفض', 'error');
        }
        try {
            const { data, error } = await client.rpc('zono_withdrawal_review_v2', {
                p_withdrawal_id: Number(id),
                p_decision: decision,
                p_rejection_reason: reason || null
            });
            if (error) throw error;
            await this.loadDeveloperTransferRequests();
            await this.loadDeveloperApprovedTransfers();
            this.showToast(decision === 'approved' ? 'تم قبول طلب السحب' : 'تم رفض الطلب وإرجاع البذور للحساب', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر معالجة الطلب', 'error');
        }
    }

    // --- Agency request workflow ---
    openAgencyRequestModal() {
        if (!this.currentUser) return this.showAuthModal();
        if (['agent','developer'].includes(this.currentUser.role)) {
            return this.showToast('الحساب وكيل/مطور بالفعل', 'info');
        }
        const modal = document.getElementById('agency-request-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        this.loadAgencyRequestHistory();
    }

    closeAgencyRequestModal() {
        const modal = document.getElementById('agency-request-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    async submitAgencyRequest() {
        if (!this.currentUser || ['agent','developer'].includes(this.currentUser.role)) return;
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client) return;
        const btn = document.getElementById('agency-request-submit');
        if (Number(this.currentUser.seeds || 0) < 1000) {
            return this.showToast('تحتاج 1,000 بذرة لإرسال طلب الوكالة', 'error');
        }
        if (!window.confirm('سيتم خصم 1,000 بذرة فوراً وإرجاعها تلقائياً إذا رُفض الطلب. متابعة؟')) return;
        try {
            if (btn) btn.disabled = true;
            const { data, error } = await client.rpc('zono_agency_create_request');
            if (error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            await this.loadAgencyRequestHistory();
            this.showToast('تم إرسال طلب الوكالة — قيد المعالجة', 'success');
        } catch (e) {
            const raw = String(e?.message || '');
            const friendly = raw.includes('PENDING_REQUEST_EXISTS') ? 'لديك طلب وكالة قيد المعالجة بالفعل'
                : raw.includes('INSUFFICIENT_SEEDS') ? 'رصيد البذور غير كافٍ'
                : raw.includes('ALREADY_AGENT') ? 'الحساب وكيل بالفعل'
                : raw;
            this.showToast(friendly || 'تعذر إرسال طلب الوكالة', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async loadAgencyRequestHistory() {
        const list = document.getElementById('agency-request-history-list');
        const btn = document.getElementById('agency-request-submit');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || !this.currentUser) return;
        try {
            const { data, error } = await client.rpc('zono_agency_my_requests');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            const hasPending = rows.some(x => x.status === 'pending');
            if (btn) {
                btn.disabled = hasPending;
                btn.textContent = hasPending ? 'طلبك قيد المعالجة' : 'طلب وكالة مقابل 1,000 بذرة';
            }
            list.innerHTML = rows.length ? rows.map(row => {
                const status = row.status === 'approved' ? 'تم قبول وكالتك'
                    : row.status === 'rejected' ? 'تم رفض وكالتك'
                    : 'قيد المعالجة';
                const cls = row.status === 'approved' ? 'zono-status-approved'
                    : row.status === 'rejected' ? 'zono-status-rejected'
                    : 'zono-status-pending';
                const reason = row.status === 'rejected' && row.rejection_reason
                    ? `<div class="text-[10px] text-red-300 mt-2">السبب: ${this.escapeHtml(row.rejection_reason)}</div>` : '';
                const assigned = row.status === 'approved' && row.assigned_public_id
                    ? `<div class="text-[10px] text-emerald-300 mt-2">ID الوكيل الجديد: ${Number(row.assigned_public_id)}</div>` : '';
                return `<div class="zono-withdrawal-row">
                    <div class="flex items-center justify-between gap-2"><strong class="text-xs text-stone-100">طلب وكالة — ${Number(row.fee_seeds || 1000).toLocaleString('en-US')} بذرة</strong><span class="zono-withdrawal-status ${cls}">${status}</span></div>
                    <div class="text-[10px] text-stone-500 mt-1">${new Date(row.created_at).toLocaleString('ar-IQ')}</div>${reason}${assigned}
                </div>`;
            }).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد طلبات وكالة سابقة</div>';
        } catch (e) {
            list.innerHTML = '<div class="text-center text-red-400 text-xs py-4">تعذر تحميل سجل طلب الوكالة</div>';
        }
    }

    async loadDeveloperAgencyRequests() {
        const list = document.getElementById('developer-admin-agent-pending-list');
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!list || !client || this.currentUser?.role !== 'developer') return;
        list.innerHTML = '<div class="text-center text-stone-500 text-xs py-4">جاري تحميل طلبات الوكالة...</div>';
        try {
            const { data, error } = await client.rpc('zono_agency_pending_requests');
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            list.innerHTML = rows.length ? rows.map(row => `
                <div class="zono-withdrawal-row border-violet-500/20">
                    <div class="flex items-center justify-between gap-2">
                        <div><strong class="text-xs text-stone-100">${this.escapeHtml(row.display_name || row.username || '')}</strong><div class="text-[10px] text-stone-500">ID الحالي ${Number(row.public_id || 0)}</div></div>
                        <span class="zono-withdrawal-status zono-status-pending">طلب وكالة</span>
                    </div>
                    <div class="text-[10px] text-stone-300 mt-2">تم حجز ${Number(row.fee_seeds || 1000).toLocaleString('en-US')} بذرة من الحساب.</div>
                    <input id="agency-new-id-${Number(row.id)}" class="zono-wallet-input mt-3" type="number" inputmode="numeric" min="1" placeholder="ID الوكيل الجديد">
                    <div class="grid grid-cols-2 gap-2 mt-3">
                        <button onclick="window.zonoApp.reviewAgencyRequest(${Number(row.id)}, 'approved')" class="zono-withdraw-approve-btn">قبول الوكالة</button>
                        <button onclick="window.zonoApp.reviewAgencyRequest(${Number(row.id)}, 'rejected')" class="zono-withdraw-reject-btn">رفض</button>
                    </div>
                </div>
            `).join('') : '<div class="text-center text-stone-500 text-xs py-4">لا توجد طلبات وكالة قيد المعالجة</div>';
        } catch (e) {
            list.innerHTML = `<div class="text-center text-red-400 text-xs py-4">${this.escapeHtml(e.message || 'تعذر تحميل طلبات الوكالة')}</div>`;
        }
    }

    async reviewAgencyRequest(id, decision) {
        if (this.currentUser?.role !== 'developer') return;
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client) return;
        let newPublicId = null;
        let reason = null;
        if (decision === 'approved') {
            newPublicId = Number(document.getElementById(`agency-new-id-${Number(id)}`)?.value || 0);
            if (!Number.isInteger(newPublicId) || newPublicId < 1) return this.showToast('اكتب ID الوكيل الجديد', 'error');
            if (!window.confirm(`تأكيد قبول الوكالة وتغيير ID الحساب إلى ${newPublicId}؟`)) return;
        } else {
            reason = String(window.prompt('اكتب سبب رفض طلب الوكالة:') || '').trim();
            if (reason.length < 3) return this.showToast('اكتب سبب الرفض', 'error');
        }
        try {
            const { data, error } = await client.rpc('zono_agency_review_request', {
                p_request_id: Number(id),
                p_decision: decision,
                p_new_public_id: newPublicId,
                p_rejection_reason: reason
            });
            if (error) throw error;
            await this.loadDeveloperAgencyRequests();
            this.showToast(decision === 'approved' ? `تم اعتماد الوكيل بـ ID ${newPublicId}` : 'تم رفض الوكالة وإرجاع البذور', 'success');
        } catch (e) {
            const raw = String(e?.message || '');
            const friendly = raw.includes('PUBLIC_ID_IN_USE') ? 'ID الوكيل الجديد مستخدم مسبقاً'
                : raw.includes('REQUEST_NOT_PENDING') ? 'هذا الطلب تمت معالجته مسبقاً'
                : raw;
            this.showToast(friendly || 'تعذر معالجة طلب الوكالة', 'error');
        }
    }

    addFeathers() {
        // رصيد الريش لا يُعدّل من المتصفح. كل عمليات الإضافة تتم من Supabase.
        this.showToast('رصيد الريش يُدار من النظام بشكل آمن.', 'info');
    }

    // --- Rooms System (الرومات) ---
    // --- Real Supabase Rooms ---
    getRoomClient() {
        return window.zonoBackend?.client || window.zonoAuth?.client || null;
    }

    async getRoomLevel(roomPublicId, fallback = 1) {
        const client = this.getRoomClient();
        const safeFallback = Number(fallback || 1);
        if (!client || !Number.isFinite(Number(roomPublicId))) return safeFallback;

        // المسار الأساسي: RPC آمن يتجاوز مشاكل RLS في القراءة المباشرة.
        try {
            const { data, error } = await client.rpc('zono_get_room_level', {
                p_room_public_id: Number(roomPublicId)
            });
            if (!error && data != null) {
                const value = Number(data);
                if (Number.isFinite(value) && value > 0) return value;
            }
        } catch (_) {}

        // fallback للنسخ التي تسمح بقراءة rooms مباشرة.
        try {
            const { data, error } = await client
                .from('rooms')
                .select('room_level')
                .eq('public_id', Number(roomPublicId))
                .maybeSingle();
            if (!error && data?.room_level != null) {
                const value = Number(data.room_level);
                if (Number.isFinite(value) && value > 0) return value;
            }
        } catch (_) {}

        return safeFallback;
    }

    async loadRooms(showToast = false) {
        const container = document.getElementById('rooms-list-container');
        const count = document.getElementById('zono-rooms-count');
        const client = this.getRoomClient();
        if (!container || !client) return;

        try {
            // v23 يضيف القسم ونوع الروم ومدة التجربة. إذا لم يُفعّل SQL الجديد نعود للدالة القديمة.
            let data, error;
            ({ data, error } = await client.rpc('zono_list_rooms_v23'));
            if (error) ({ data, error } = await client.rpc('zono_list_rooms'));
            if (error) throw error;

            let roomRows = (Array.isArray(data) ? data : []).filter(Boolean);

            // جلب مستوى كل روم من RPC مخصص؛ هذا يعمل حتى لو كانت RLS تمنع SELECT المباشر.
            roomRows = await Promise.all(roomRows.map(async (room) => ({
                ...room,
                room_level: await this.getRoomLevel(room.public_id, room.room_level ?? 1)
            })));

            this.rooms = roomRows
                .sort((a,b) => Number(b.active_members || 0) - Number(a.active_members || 0));
            this.renderRooms();
            if (showToast) this.showToast('تم تحديث الرومات', 'success');
        } catch (e) {
            if (count) count.textContent = '0 روم';
            container.innerHTML = `<div class="zono-rooms-empty"><div class="text-3xl mb-2">⚠️</div><div>تعذر تحميل الرومات</div><div class="text-[10px] mt-1">${this.escapeHtml(e.message || '')}</div></div>`;
        }
    }

    getRoomCategoryLabel(category) {
        const map = {
            general:'عام', poetry:'شعر', songs:'أغاني', music:'موسيقى',
            challenges:'تحديات', contests:'مسابقات'
        };
        return map[String(category || 'general')] || 'عام';
    }

    setRoomSearch(value) {
        this.roomSearch = String(value || '').trim().toLowerCase();
        this.renderRooms();
    }

    setRoomFilter(filter, button = null) {
        this.roomFilter = String(filter || 'all');
        document.querySelectorAll('.zono-room-filter-chip').forEach(btn => btn.classList.toggle('active', btn === button || btn.dataset.roomFilter === this.roomFilter));
        this.renderRooms();
    }

    getVisibleRooms() {
        const q = this.roomSearch;
        return [...(this.rooms || [])]
            .filter(room => {
                const cat = String(room.category || room.room_category || 'general');
                if (this.roomFilter === 'following' && !(room.is_favorite || room.is_following || room.following)) return false;
                if (!['all','following'].includes(this.roomFilter) && cat !== this.roomFilter) return false;
                if (!q) return true;
                const name = String(room.name || '').toLowerCase();
                const id = String(room.public_id || '').toLowerCase();
                return name.includes(q) || id.includes(q);
            })
            .sort((a,b) => Number(b.active_members || 0) - Number(a.active_members || 0));
    }

    renderRooms() {
        const container = document.getElementById('rooms-list-container');
        const count = document.getElementById('zono-rooms-count');
        if (!container) return;

        const visible = this.getVisibleRooms();
        if (count) count.textContent = `${visible.length} روم`;

        if (!visible.length) {
            container.innerHTML = `
                <div class="zono-rooms-empty">
                    <div class="text-4xl mb-3">🏛️</div>
                    <div class="font-black text-stone-200">لا توجد رومات مطابقة</div>
                    <div class="text-xs text-stone-500 mt-1">غيّر البحث أو القسم لعرض رومات أخرى.</div>
                </div>`;
            return;
        }

        container.innerHTML = visible.map(room => {
            const category = String(room.category || room.room_category || 'general');
            return `
            <button onclick="window.zonoApp.openRoom(${Number(room.public_id)})" class="zono-room-square-card">
                <img src="${this.escapeHtml(room.image_url || '')}" alt="${this.escapeHtml(room.name || 'Room')}" class="zono-room-card-image">
                <div class="zono-room-card-overlay"></div>
                <span class="zono-room-category-chip">${this.escapeHtml(this.getRoomCategoryLabel(category))}</span>

                <div class="zono-room-card-top has-category">
                    <span class="zono-room-id-chip">ID ${Number(room.public_id)}</span>
                    <span class="zono-room-lock-chip">${room.is_locked ? '🔒' : '🌐'}</span>
                </div>

                <div class="zono-room-card-bottom">
                    <div class="zono-room-name-marquee">
                        <div class="zono-room-name-track">${this.escapeHtml(room.name || '')} ✦ ${this.escapeHtml(room.name || '')}</div>
                    </div>
                    <div class="zono-room-card-meta">
                        <span>LV.${Number(room.room_level || 1)} ⭐</span>
                        <span>${Number(room.active_members || 0)} 👥</span>
                        <span>${this.escapeHtml(room.owner_name || '')}</span>
                    </div>
                </div>
            </button>`;
        }).join('');
    }

    openCreateRoomModal() {
        if (!this.currentUser) return this.showAuthModal();

        const modal = document.getElementById('zono-create-room-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        const file = document.getElementById('zono-room-image-input');
        if (file && !file.dataset.bound) {
            file.dataset.bound = '1';
            file.addEventListener('change', () => {
                const f = file.files?.[0];
                const wrap = document.getElementById('zono-room-image-preview-wrap');
                const img = document.getElementById('zono-room-image-preview');
                if (!f || !wrap || !img) return;
                img.src = URL.createObjectURL(f);
                wrap.classList.remove('hidden');
            });
        }
    }

    showSelectedRoomPlanInfo() {
        const plan = String(document.querySelector('input[name="zono-room-plan"]:checked')?.value || 'permanent');
        const modal = document.getElementById('zono-permanent-room-info-modal');
        const title = document.getElementById('zono-plan-info-title');
        const content = document.getElementById('zono-plan-info-content');
        if (!modal || !title || !content) return;

        if (plan === 'trial') {
            title.textContent = 'الروم المجاني';
            content.innerHTML = `
                <p class="zono-plan-info-lead">الروم المجاني متاح لمدة <b>60 يومًا</b> ومرة واحدة فقط لكل حساب.</p>
                <p class="zono-plan-info-muted">سيتم إضافة تفاصيل الروم المجاني هنا لاحقًا.</p>`;
        } else {
            const ownerName = this.escapeHtml(this.currentUser?.displayName || 'عضو ZONO');
            title.textContent = '👑 امتلك غرفتك الدائمة 🌍';
            content.innerHTML = `
                <p class="zono-plan-info-lead">مرحباً بك يا <b>${ownerName}</b> 💜</p>
                <p>هل ترغب في امتلاك غرفة دردشة عالمية دائمة تكون ملكاً لك؟ 🌎✨</p>
                <p>🌱 عند شراء الغرفة باستخدام البذور، تصبح الغرفة دائمة ومملوكة لك، وتفتح لك مجموعة من المزايا الخاصة والحصرية. 👑</p>
                <h4>💎 مزايا الغرفة الدائمة</h4>
                <p>🏆 <b>1. مستوى الغرفة</b><br>📈 يبدأ مستوى الغرفة من Lv.1 ويصل حتى Lv.300.<br>🎁 كلما ارتفع مستوى الغرفة، تحصل على مزايا وتطويرات إضافية وحصرية.</p>
                <p>🖼️ <b>2. تغيير صورة الغرفة</b><br>✨ يمكنك تغيير صورة الغرفة مرة كل 7 أيام.</p>
                <p>✏️ <b>3. تغيير اسم الغرفة</b><br>🏷️ يمكنك تغيير اسم الغرفة مرة واحدة كل 7 أيام.</p>
                <p>🌌 <b>4. خلفية خاصة</b><br>🎨 اختر خلفية مميزة لغرفتك من الخلفيات الجاهزة، أو استخدم خلفية خاصة حسب النظام المتاح.</p>
                <p>🎁 <b>5. أرباح صاحب الغرفة</b><br>💰 يحصل مالك الغرفة الدائم على نسبة 20% من الهدايا التي يتم إرسالها داخل الغرفة أثناء وجوده فيها.<br>🚪 عند خروج مالك الغرفة، تنتقل النسبة المخصصة له إلى الشركة.<br>🎁 يتم توزيع قيمة الهدية وفق نظام المنصة وتقسيمها على الأطراف المحددة بالنظام.</p>
                <p>🎤 <b>6. تأجير المايكات</b><br>🎙️ إمكانية تأجير المايكات داخل الغرفة، وإتاحة استخدامها للمستخدمين حسب نظام الغرفة.</p>
                <p>🎵 <b>7. تشغيل الأغاني</b><br>🎶 يمكنك تشغيل وإضافة الأغاني داخل الغرفة لإضفاء جو ممتع على الدردشة.</p>
                <p>👆 <b>8. البصمات</b><br>🔥 فتح خاصية البصمات والتفاعلات داخل الغرفة.</p>
                <p>👑 <b>9. دخول ملكي</b><br>✨ دخول خاص ومميز لمالك الغرفة مع مظهر ملكي يظهر للمستخدمين.</p>
                <p>🛡️ <b>10. إدارة المشرفين</b><br>👮‍♂️ يستطيع مالك الغرفة:<br>⬆️ تعيين مشرف<br>⬇️ إزالة المشرف<br>🔒 إدارة صلاحيات المشرفين<br>⚙️ التحكم بإدارة الغرفة</p>
                <p>🌙 <b>11. الغرفة مفتوحة دائماً</b><br>🕐 الغرفة الدائمة تعمل 24 ساعة / 7 أيام ولا تنتهي مدتها.</p>
                <p>🔐 <b>12. حماية الغرفة</b><br>🔑 إمكانية وضع كلمة مرور للغرفة والتحكم بمن يستطيع الدخول إليها.</p>
                <h4>👑 امتلكها... ولا تستأجرها!</h4>
                <p>🌱 غرفة دائمة = ملكية + مزايا + إدارة + تميز</p>
                <p>✨ اجعل غرفتك مكانك الخاص<br>🎁 استقبل الهدايا<br>🎙️ استمتع بالمايكات<br>🎵 شغّل الأغاني<br>👑 احصل على دخول ملكي<br>🛡️ عيّن مشرفيك<br>🌎 واجعل غرفتك متاحة للجميع على مدار الساعة</p>
                <p class="zono-plan-info-lead">💜 هل أنت مستعد لامتلاك غرفتك؟</p>`;
        }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    showPermanentRoomInfo() {
        this.showSelectedRoomPlanInfo();
    }

    hidePermanentRoomInfo() {
        const modal=document.getElementById('zono-permanent-room-info-modal');
        if(modal){modal.classList.add('hidden');modal.classList.remove('flex');}
    }

    closeCreateRoomModal() {
        const modal = document.getElementById('zono-create-room-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    async uploadRoomImage(file) {
        const client = this.getRoomClient();
        if (!client || !file) throw new Error('اختر صورة للروم');
        if (!file.type?.startsWith('image/')) throw new Error('الملف يجب أن يكون صورة');
        if (file.size > 3 * 1024 * 1024) throw new Error('حجم صورة الروم يجب ألا يتجاوز 3MB');

        const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase();
        const path = `${window.zonoAuth?.user?.id || 'user'}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error } = await client.storage.from('room-images').upload(path, file, {
            cacheControl:'3600',
            upsert:false,
            contentType:file.type
        });
        if (error) throw error;
        const { data } = client.storage.from('room-images').getPublicUrl(path);
        return data.publicUrl;
    }

    async createRoom() {
        const client = this.getRoomClient();
        if (!client || !this.currentUser) return;

        const name = String(document.getElementById('zono-room-name-input')?.value || '').trim();
        const bio = String(document.getElementById('zono-room-bio-input')?.value || '').trim();
        const file = document.getElementById('zono-room-image-input')?.files?.[0];
        const category = String(document.getElementById('zono-room-category-input')?.value || 'general');
        const plan = String(document.querySelector('input[name="zono-room-plan"]:checked')?.value || 'permanent');

        if (name.length < 2 || name.length > 60) return this.showToast('اسم الروم يجب أن يكون من 2 إلى 60 حرفًا', 'error');
        if (bio.length < 2 || bio.length > 240) return this.showToast('أدخل نبذة مناسبة للروم', 'error');
        if (!file) return this.showToast('اختر صورة للروم', 'error');
        if (!['general','poetry','songs','music','challenges','contests'].includes(category)) return this.showToast('اختر قسمًا صحيحًا للروم', 'error');
        if (!['permanent','trial'].includes(plan)) return this.showToast('اختر نوع الروم', 'error');
        if (plan === 'permanent' && Number(this.currentUser.seeds || 0) < 50000) {
            return this.showToast('عذراً، بذورك غير كافية — 50,000 بذرة', 'error');
        }

        try {
            this.showToast('جاري رفع صورة الروم...', 'info');
            const imageUrl = await this.uploadRoomImage(file);

            let data, error;
            ({data,error}=await client.rpc('zono_create_room_v23', {
                p_name:name,
                p_bio:bio,
                p_image_url:imageUrl,
                p_category:category,
                p_plan:plan
            }));

            // توافق مؤقت مع قاعدة البيانات القديمة حتى يتم تشغيل ملف SQL المرفق.
            if (error && /zono_create_room_v23|function|schema cache|could not find/i.test(String(error.message||error))) {
                if (plan === 'trial') throw new Error('تعذر إنشاء الغرفة المجانية حاليًا. يلزم تحديث قاعدة البيانات.');
                ({data,error}=await client.rpc('zono_create_room', {p_name:name,p_bio:bio,p_image_url:imageUrl}));
            }
            if (error) throw error;

            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            this.updateProfileUI();

            ['zono-room-name-input','zono-room-bio-input'].forEach(id => {
                const el=document.getElementById(id); if(el) el.value='';
            });
            const fi=document.getElementById('zono-room-image-input'); if(fi) fi.value='';
            const cat=document.getElementById('zono-room-category-input'); if(cat) cat.value='general';
            const permanent=document.querySelector('input[name="zono-room-plan"][value="permanent"]'); if(permanent) permanent.checked=true;
            document.getElementById('zono-room-image-preview-wrap')?.classList.add('hidden');

            this.closeCreateRoomModal();
            await this.loadRooms();
            this.showToast('تم شراء غرفة بنجاح', 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر إنشاء الروم', 'error');
        }
    }

    async openRoom(roomPublicId, password = null) {
        if (!this.currentUser) return this.showAuthModal();
        const client = this.getRoomClient();
        if (!client) return;

        const listRoom = this.rooms.find(r => Number(r.public_id) === Number(roomPublicId));

        try {
            const { data, error } = await client.rpc('zono_enter_room', {
                p_room_public_id:Number(roomPublicId),
                p_password:password
            });
            if (error) throw error;

            this.activeRoom = data;
            if (listRoom) {
                this.activeRoom.category = listRoom.category || listRoom.room_category || 'general';
                this.activeRoom.plan_type = listRoom.plan_type || listRoom.room_plan || 'permanent';
                this.activeRoom.trial_expires_at = listRoom.trial_expires_at || null;
            }
            this.activeRoom.messages = [];
            this.roomMusicState = null;
            this.roomMusicSongs = [];

            this.roomInitialMessagesLoaded = false;
            this.pendingProtectedRoom = null;
            this.closeRoomPasswordModal();

            const modal=document.getElementById('room-chat-modal');
            document.getElementById('room-modal-title').textContent = data.name || 'الروم';
            const lvl=document.getElementById('room-modal-level');
            let resolvedRoomLevel = await this.getRoomLevel(
                roomPublicId,
                data.room_level ?? listRoom?.room_level ?? 1
            );
            this.activeRoom.room_level = resolvedRoomLevel;
            if(lvl) lvl.textContent=`LV. ${resolvedRoomLevel} ⭐`;
            const ridEl=document.getElementById('room-modal-public-id'); if(ridEl) ridEl.textContent=`ID ${Number(data.public_id)}`; const numEl=document.getElementById('zono-room-member-number'); if(numEl) numEl.textContent=String(Number(data.active_members||1));
            this.activeRoom.is_favorite=!!data.is_favorite;
            this.updateRoomFavoriteButton();
            document.getElementById('room-modal-image').src = data.image_url || '';
            document.getElementById('room-modal-lock')?.classList.toggle('hidden', !data.is_locked);

            const adminBtn=document.getElementById('room-admin-button');
            if (adminBtn) adminBtn.classList.toggle('hidden', !data.is_owner);

            if (modal) modal.classList.remove('hidden');

            history.pushState({zonoRoomOpen:true,roomId:Number(data.public_id)},'',location.href);
            this._roomHistoryArmed=true;

            this.applyRoomVisuals(data);
            await this.loadRoomMessages();
            await this.loadRoomMembers();
            await this.loadRoomMicState();
            await this.loadRoomMusicState(true);

            if (window.zonoLiveVoice) {
                await window.zonoLiveVoice.joinRoom(Number(data.public_id));
                await window.zonoLiveVoice.syncMicState();
                this.showRoomEntryNotice({
                    display_name:this.currentUser?.displayName,
                    name_theme:this.activeNameTheme || 'basic'
                });
                await window.zonoLiveVoice.announceRoomEntry({
                    display_name:this.currentUser?.displayName,
                    name_theme:this.activeNameTheme || 'basic'
                });
            }

            clearInterval(this.roomPollTimer);
            clearInterval(this.roomPresenceTimer);
            this.roomPollTimer = setInterval(() => {
                if (this.activeRoom) {
                    this.loadRoomMessages(true);
                    this.loadRoomMembers();
                    this.loadRoomMicState();
                    this.loadRoomMusicState(true);
                }
            }, 2000);
            this.roomPresenceTimer = setInterval(() => {
                if (this.activeRoom) this.roomHeartbeat();
            }, 12000);
        } catch (e) {
            const msg = String(e.message || '');
            if (msg.includes('ROOM_PASSWORD_REQUIRED') || msg.includes('ROOM_PASSWORD_INVALID')) {
                this.pendingProtectedRoom = Number(roomPublicId);
                const name = listRoom?.name || 'الروم المحمي';
                document.getElementById('zono-protected-room-name').textContent = name;
                const modal = document.getElementById('zono-room-password-modal');
                modal?.classList.remove('hidden');
                modal?.classList.add('flex');
                if (msg.includes('INVALID')) this.showToast('رمز الدخول غير صحيح', 'error');
                return;
            }
            if (msg.includes('ROOM_BANNED')) return this.showToast('أنت محظور من دخول هذا الروم', 'error');
            if (msg.includes('ROOM_KICKED')) return this.showToast('تم طردك من الروم، حاول لاحقًا', 'error');
            this.showToast(msg || 'تعذر دخول الروم', 'error');
        }
    }

    submitRoomPassword() {
        const value=String(document.getElementById('zono-room-password-input')?.value || '');
        if (!this.pendingProtectedRoom) return;
        if (!value) return this.showToast('أدخل رمز الروم', 'error');
        this.openRoom(this.pendingProtectedRoom, value);
    }

    closeRoomPasswordModal() {
        const modal=document.getElementById('zono-room-password-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
        const input=document.getElementById('zono-room-password-input'); if(input) input.value='';
    }

    showRoomEntryCapsule() {
        this.showRoomEntryNotice({
            display_name:this.currentUser?.displayName,
            name_theme:this.activeNameTheme || 'basic'
        });
    }

    showRoomEntryNotice(payload={}) {
        const wrap=document.getElementById('zono-room-entry-capsule');
        const name=document.getElementById('zono-room-entry-name');
        const textEl=document.getElementById('zono-room-entry-text');
        if(!wrap||!name) return;

        const themeKey=payload.name_theme || 'basic';
        const cls=this.getNameThemeCatalog().find(x=>x.key===themeKey)?.cls || 'zono-name-basic';
        name.textContent=payload.display_name || 'عضو Zono';
        name.className=`zono-name-text ${cls}`;
        if(textEl) textEl.textContent='دخل الروم';

        wrap.setAttribute('data-name-theme',themeKey);
        wrap.classList.remove('hidden','zono-room-entry-mini-show');
        void wrap.offsetWidth;
        wrap.classList.add('zono-room-entry-mini-show');

        clearTimeout(this._roomEntryTimer);
        this._roomEntryTimer=setTimeout(()=>wrap.classList.add('hidden'),2800);
    }

    async roomHeartbeat() {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom) return;
        try {
            const { data, error } = await client.rpc('zono_room_heartbeat', {
                p_room_public_id:Number(this.activeRoom.public_id)
            });
            if (error) throw error;
            if (data?.allowed === false) {
                this.showToast(data.reason || 'تم إخراجك من الروم', 'error');
                this.closeRoomModal();
            }
        } catch (_) {}
    }

    async loadRoomMessages(silent = false) {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom) return;
        try {
            // The server deletes room messages older than 60 minutes.
            // On entry show only the latest 10; while the user stays, allow up to 100.
            const { data, error } = await client.rpc('zono_room_messages', {
                p_room_public_id:Number(this.activeRoom.public_id)
            });
            if (error) throw error;
            const all = Array.isArray(data) ? [...data].reverse() : [];
            const limit = this.roomInitialMessagesLoaded ? 100 : 10;
            this.activeRoom.messages = all.slice(-limit);
            this.roomInitialMessagesLoaded = true;
            this.renderRoomMessages();
        } catch (e) {
            if (!silent) this.showToast(e.message || 'تعذر تحميل الرسائل', 'error');
        }
    }

    renderRoomMessages() {
        const container=document.getElementById('room-messages-flow');
        if (!container || !this.activeRoom) return;

        const messages=this.activeRoom.messages || [];
        const tasteKey=`zono_taste_seen_${this.currentUser?.publicId||'guest'}_${this.activeRoom.public_id}`;
        const showTaste=!localStorage.getItem(tasteKey);
        const guidelines=showTaste?`<div class="zono-guidelines-message zono-public-taste"><div class="zono-guidelines-message-head">🛡️ <b>الذوق العام</b><span>✓ عام</span></div><p>تنبيه عام: يمنع التنمر والسب والشتم والتجاوز والتحرش والإساءة للآخرين. هذه رسالة تحذيرية ولا تمنعك من دخول الرومات.</p></div>`:'';
        if(showTaste) localStorage.setItem(tasteKey,'1');

        if (!messages.length) {
            container.innerHTML=guidelines+'<div class="text-center text-stone-600 text-xs py-8">لا توجد رسائل بعد. ابدأ أول رسالة في الروم.</div>';
            return;
        }

        container.innerHTML=guidelines+messages.map(msg=>{
            const isMe = Number(msg.sender_public_id) === Number(this.currentUser?.publicId);
            if (msg.message_type === 'gift') {
                return `<div class="zono-room-gift-event zono-force-right" style="margin-left:auto!important;margin-right:0!important;direction:rtl!important;text-align:right!important;">
                    <div class="zono-room-gift-rose">🌹</div>
                    <div>
                        <b>${this.escapeHtml(msg.sender_name || '')}</b>
                        <span>${this.escapeHtml(msg.content || '')}</span>
                    </div>
                </div>`;
            }

            if (msg.message_type === 'voice') {
                const nameCls = this.getNameThemeCatalog().find(x=>x.key===msg.name_theme)?.cls || 'zono-name-basic';
                const frameCls = this.getAvatarFrameCatalog().find(x=>x.key===msg.avatar_frame)?.cls || 'zono-frame-basic';
                const isMeVoice = Number(msg.sender_public_id) === Number(this.currentUser?.publicId);
                return `<div class="flex flex-col mb-3 zono-force-right">
                    <div class="zono-room-message-layout">
                        <div class="zono-avatar-frame ${frameCls} zono-room-message-avatar">
                            <div class="zono-frame-crown"></div><img src="${this.escapeHtml(msg.sender_avatar || '')}" alt="">
                        </div>
                        <div class="zono-room-message-body">
                            <div class="zono-room-msg-head">
                                <span class="zono-name-text ${nameCls}">${this.escapeHtml(msg.sender_name || '')}</span>
                                <span class="zono-account-level">LV.${Number(msg.sender_level||1)}</span>
                            </div>
                            <div class="zono-voice-message zono-glass-message">
                                <button onclick="window.zonoApp.toggleVoicePlayback(this,'${this.escapeHtml(msg.media_url || '')}')" class="zono-voice-play">▶</button>
                                <div class="zono-voice-waveform"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
                                <span>${this.formatVoiceDuration(Number(msg.media_duration || 0))}</span>
                                ${(this.activeRoom?.is_owner || this.activeRoom?.is_moderator) ? `<button onclick="window.zonoApp.deleteRoomMessage(${Number(msg.id)})" class="zono-voice-delete">🗑️</button>` : ''}
                            </div>
                        </div>
                    </div>
                </div>`;
            }

            const nameCls = this.getNameThemeCatalog().find(x=>x.key===msg.name_theme)?.cls || 'zono-name-basic';
            const frameCls = this.getAvatarFrameCatalog().find(x=>x.key===msg.avatar_frame)?.cls || 'zono-frame-basic';

            return `<div class="flex flex-col mb-3 zono-force-right">
                <div class="zono-room-message-layout">
                    <div class="zono-avatar-frame ${frameCls} zono-room-message-avatar">
                        <div class="zono-frame-crown"></div>
                        <img src="${this.escapeHtml(msg.sender_avatar || '')}" alt="">
                    </div>
                    <div class="zono-room-message-body">
                        <div class="zono-room-msg-head">
                            <span class="zono-name-text ${nameCls}">${this.escapeHtml(msg.sender_name || '')}</span>
                            <span class="zono-account-level">LV.${Number(msg.sender_level||1)}</span>
                            <span class="zono-room-msg-time">${new Date(msg.created_at).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})}</span>
                        </div>
                        <div class="zono-room-text-actions ${isMe?'is-me':''}">
                            <div class="p-3 rounded-2xl max-w-[85%] text-sm zono-glass-message ${isMe?'bubble-sent text-emerald-100':'bubble-rcvd text-stone-200'} shadow">
                                ${this.escapeHtml(msg.content || '')}
                            </div>
                            ${(this.activeRoom?.is_owner || this.activeRoom?.is_moderator) ? `<button onclick="window.zonoApp.deleteRoomMessage(${Number(msg.id)})" class="zono-msg-delete" title="حذف الرسالة">🗑️</button>` : ''}
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('');

        container.scrollTop=container.scrollHeight;
    }

    async sendRoomMessage() {
        const client=this.getRoomClient();
        const input=document.getElementById('room-message-input');
        if (!client || !input || !this.activeRoom) return;
        const text=String(input.value || '').trim();
        if (!text) return;

        try {
            const { error } = await client.rpc('zono_send_room_message', {
                p_room_public_id:Number(this.activeRoom.public_id),
                p_message:text
            });
            if (error) throw error;
            input.value='';
            await this.loadRoomMessages(true);
            if (window.zonoAudio) window.zonoAudio.playKikSent();
        } catch (e) {
            const msg=String(e.message || '');
            if (msg.includes('MUTED')) {
                document.getElementById('room-muted-notice')?.classList.remove('hidden');
                return this.showToast('أنت مكتوم داخل هذا الروم', 'error');
            }
            this.showToast(msg || 'تعذر إرسال الرسالة', 'error');
        }
    }

    async loadRoomMembers(showToast = false) {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom) return;
        try {
            const { data, error } = await client.rpc('zono_room_members', {
                p_room_public_id:Number(this.activeRoom.public_id)
            });
            if (error) throw error;
            this.roomMembers=Array.isArray(data)?data:[];
            const countEl=document.getElementById('room-modal-count');
            if(countEl) countEl.title=`${this.roomMembers.length} متواجد`; const numEl=document.getElementById('zono-room-member-number'); if(numEl) numEl.textContent=String(this.roomMembers.length); const av=document.getElementById('zono-room-member-avatars'); if(av) av.innerHTML=this.roomMembers.slice(0,5).map(m=>`<img src="${this.escapeHtml(m.avatar||'')}" alt="">`).join('');
            const sheetCount=document.getElementById('zono-members-sheet-count');
            if(sheetCount) sheetCount.textContent=String(this.roomMembers.length);
            if (showToast) this.showToast('تم تحديث المتواجدين', 'success');
            this.renderRoomAdminMembers();
            this.renderRoomMembersPanel();
        } catch (_) {}
    }

    async openRoomOwnerInfo() {
        if(!this.activeRoom) return;
        const modal=document.getElementById('zono-room-owner-info-modal');
        const card=document.getElementById('zono-room-owner-card');
        modal?.classList.remove('hidden'); modal?.classList.add('flex');
        if(!card) return;
        card.innerHTML='<div class="text-center text-stone-500 py-5">جاري تحميل مالك الروم...</div>';
        const client=this.getRoomClient();
        try{
            const {data,error}=await client.rpc('zono_room_owner_info_v8',{p_room_public_id:Number(this.activeRoom.public_id)});
            if(error) throw error;
            const frameCls=this.getAvatarFrameCatalog().find(x=>x.key===data.avatar_frame)?.cls || 'zono-frame-basic';
            card.innerHTML=`<div class="zono-owner-profile">
                <div class="zono-avatar-frame ${frameCls} zono-owner-avatar"><div class="zono-frame-crown"></div><img src="${this.escapeHtml(data.avatar||'')}" alt=""></div>
                <div class="zono-owner-meta">
                    <b>${this.escapeHtml(data.display_name||'مالك الروم')}</b>
                    <span class="zono-account-level">LV.${Number(data.account_level||1)}</span>
                    <small>ID ${Number(data.public_id||0)}</small>
                    <em>👑 مالك الروم</em></div></div><div class="zono-room-welcome-card"><b>👋 ترحيب الغرفة</b><p>${this.escapeHtml(data.welcome_message||'أهلاً بك في الغرفة')}</p></div>`;
        }catch(e){card.innerHTML=`<div class="text-center text-red-300 py-5">${this.escapeHtml(e.message||'تعذر تحميل معلومات المالك')}</div>`}
    }

    closeRoomOwnerInfo() {
        const modal=document.getElementById('zono-room-owner-info-modal');
        modal?.classList.add('hidden'); modal?.classList.remove('flex');
    }

    openRoomMembersPanel() {
        if(!this.activeRoom) return;
        const modal=document.getElementById('zono-room-members-modal');
        modal?.classList.remove('hidden'); modal?.classList.add('flex');
        this.loadRoomMembers();
    }

    closeRoomMembersPanel() {
        const modal=document.getElementById('zono-room-members-modal');
        modal?.classList.add('hidden'); modal?.classList.remove('flex');
    }

    renderRoomMembersPanel() {
        const box=document.getElementById('zono-room-members-list');
        if(!box) return;
        const members=[...(this.roomMembers||[])];
        const mods=members.filter(m=>!m.is_owner && (m.is_moderator||m.is_manager));
        const users=members.filter(m=>!m.is_owner && !m.is_moderator && !m.is_manager);

        const card=(m)=>{
            const role=m.is_manager?'مسؤول':m.is_moderator?'مشرف':'عضو';
            const frameCls=this.getAvatarFrameCatalog().find(x=>x.key===m.avatar_frame)?.cls || 'zono-frame-basic';
            return `<div class="zono-member-public-card">
                <div class="zono-avatar-frame ${frameCls} zono-member-public-avatar"><div class="zono-frame-crown"></div><img src="${this.escapeHtml(m.avatar||'')}" alt=""></div>
                <div class="zono-member-public-meta">
                    <div><b>${this.escapeHtml(m.display_name||'')}</b><span class="zono-account-level">LV.${Number(m.account_level||1)}</span></div>
                    <small>ID ${Number(m.public_id||0)}</small>
                    <em>${role==='عضو'?'👤':role==='مشرف'?'🛡️':'⭐'} ${role}</em>
                </div>
            </div>`;
        };

        box.innerHTML=`
            ${mods.length?`<div class="zono-member-section-title">🛡️ المشرفون <span>${mods.length}</span></div>${mods.map(card).join('')}`:''}
            <div class="zono-member-section-title">👥 الأعضاء <span>${users.length}</span></div>
            ${users.map(card).join('') || '<div class="text-center text-stone-500 py-6 text-xs">لا يوجد أعضاء آخرون حاليًا</div>'}
        `;
    }

    toggleRoomEmojiPanel() {
        document.getElementById('zono-room-emoji-panel')?.classList.toggle('hidden');
    }

    insertRoomEmoji(emoji) {
        const input=document.getElementById('room-message-input');
        if(!input) return;
        const start=input.selectionStart??input.value.length;
        const end=input.selectionEnd??input.value.length;
        input.value=input.value.slice(0,start)+emoji+input.value.slice(end);
        input.focus();
        const pos=start+emoji.length;
        input.setSelectionRange?.(pos,pos);
    }

    openRoomAdmin() {
        if (!this.activeRoom || !(this.activeRoom.is_owner || this.activeRoom.is_moderator)) return;
        const modal=document.getElementById('zono-room-admin-modal');
        modal?.classList.remove('hidden');
        modal?.classList.add('flex');
        document.getElementById('zono-room-admin-role').textContent=this.activeRoom.is_owner?'مالك الروم':'مشرف الروم';
        document.getElementById('zono-room-delete-wrap')?.classList.toggle('hidden',!this.activeRoom.is_owner);
        document.getElementById('zono-room-owner-settings')?.classList.toggle('hidden',!this.activeRoom.is_owner);
        document.getElementById('zono-mic-package-buttons')?.classList.toggle('hidden',!this.activeRoom.is_owner);
        const guide = document.getElementById('zono-room-guidelines-input');
        if (guide) guide.value = this.activeRoom.guidelines_text || ''; const w=document.getElementById('zono-room-welcome-input'); if(w) w.value=this.activeRoom.welcome_message||'';
        const mode = document.getElementById('zono-room-mic-mode-select');
        if (mode) mode.value = this.activeRoom.mic_mode || 'open';
        this.loadRoomMembers();
        this.loadRoomMicState();
        this.loadRoomMusicState(true);
    }

    async saveRoomWelcomeMessage() {
        if(!this.activeRoom?.is_owner) return;
        const text=(document.getElementById('zono-room-welcome-input')?.value||'').trim();
        const client=this.getRoomClient();
        try{const {data,error}=await client.rpc('zono_room_update_welcome_v8',{p_room_public_id:Number(this.activeRoom.public_id),p_welcome_message:text}); if(error) throw error; this.activeRoom.welcome_message=text; this.showToast('تم حفظ رسالة الترحيب','success')}catch(e){this.showToast(e.message||'تعذر الحفظ','error')}
    }

    closeRoomAdmin() {
        const modal=document.getElementById('zono-room-admin-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    }

    renderRoomAdminMembers() {
        const box=document.getElementById('zono-room-admin-members');
        if (!box || !this.activeRoom) return;

        box.innerHTML=this.roomMembers.map(m=>{
            const isOwner=!!m.is_owner;
            const isMod=!!m.is_moderator;
            const isSelf=Number(m.public_id)===Number(this.currentUser?.publicId);

            return `<div class="zono-room-member-row">
                <div class="flex items-center gap-2 min-w-0">
                    <img src="${this.escapeHtml(m.avatar || '')}" class="w-9 h-9 rounded-full object-cover border border-stone-700">
                    <div class="min-w-0">
                        <div class="text-xs font-black text-stone-200 truncate">${this.escapeHtml(m.display_name || '')}</div>
                        <div class="text-[9px] text-stone-500">ID ${Number(m.public_id)} ${isOwner?'• المالك':isMod?'• مشرف':''}</div>
                    </div>
                </div>
                ${isSelf || isOwner ? '' : `<div class="zono-member-actions">
                    ${this.activeRoom.is_owner ? `<button onclick="window.zonoApp.setRoomModerator(${Number(m.public_id)},${!isMod})">${isMod?'إلغاء الإشراف':'مشرف'}</button>` : ''}
                    <button onclick="window.zonoApp.moderateRoomUser(${Number(m.public_id)},'kick')">طرد</button>
                    <button onclick="window.zonoApp.moderateRoomUser(${Number(m.public_id)},'ban')">حظر</button>
                    <button onclick="window.zonoApp.moderateRoomUser(${Number(m.public_id)},'mute_temp')">كتم وقتي</button>
                    <button onclick="window.zonoApp.moderateRoomUser(${Number(m.public_id)},'mute_perm')">كتم دائم</button>
                    <button onclick="window.zonoApp.moderateRoomUser(${Number(m.public_id)},'clear')">فك</button>
                </div>`}
            </div>`;
        }).join('') || '<div class="text-center text-stone-500 text-xs py-5">لا يوجد أعضاء نشطون</div>';
    }

    async setRoomModerator(publicId, enabled) {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom?.is_owner) return;
        try {
            const { error }=await client.rpc('zono_room_set_moderator',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_target_public_id:Number(publicId),
                p_enabled:!!enabled
            });
            if(error) throw error;
            await this.loadRoomMembers();
            this.showToast(enabled?'تم تعيين مشرف':'تم إلغاء الإشراف','success');
        } catch(e){this.showToast(e.message||'تعذر تحديث المشرف','error')}
    }

    async moderateRoomUser(publicId, action) {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom) return;

        let minutes=null;
        if(action==='mute_temp'){
            const value=window.prompt('مدة الكتم بالدقائق (مثلاً 30):','30');
            if(value===null) return;
            minutes=Math.max(1,Math.min(10080,Number(value)||30));
        }

        try{
            const {error}=await client.rpc('zono_room_moderate',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_target_public_id:Number(publicId),
                p_action:action,
                p_minutes:minutes
            });
            if(error) throw error;
            await this.loadRoomMembers();
            this.showToast('تم تنفيذ الإجراء','success');
        }catch(e){this.showToast(e.message||'تعذر تنفيذ الإجراء','error')}
    }

    async setRoomLock(locked) {
        const client=this.getRoomClient();
        if (!client || !this.activeRoom) return;

        let password=null;
        if(locked){
            password=window.prompt('ضع رمز دخول للروم (4 إلى 12 حرف/رقم):','');
            if(password===null) return;
            if(password.length<4||password.length>12) return this.showToast('الرمز يجب أن يكون من 4 إلى 12 خانة','error');
        }

        try{
            const {error}=await client.rpc('zono_room_set_lock',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_locked:!!locked,
                p_password:password
            });
            if(error) throw error;
            this.activeRoom.is_locked=!!locked;
            document.getElementById('room-modal-lock')?.classList.toggle('hidden',!locked);
            await this.loadRooms();
            this.showToast(locked?'تم قفل الروم':'تم فتح الروم','success');
        }catch(e){this.showToast(e.message||'تعذر تحديث حالة الروم','error')}
    }

    async deleteCurrentRoom() {
        if (!this.activeRoom?.is_owner) return;
        const ok=window.confirm('سيتم حذف الروم نهائيًا ولن تعود 50,000 بذرة. هل أنت متأكد؟');
        if(!ok) return;

        const client=this.getRoomClient();
        try{
            const {error}=await client.rpc('zono_delete_room',{
                p_room_public_id:Number(this.activeRoom.public_id)
            });
            if(error) throw error;
            this.closeRoomAdmin();
            this.closeRoomModal();
            await this.loadRooms();
            this.showToast('تم حذف الروم نهائيًا بدون استرجاع البذور','success');
        }catch(e){this.showToast(e.message||'تعذر حذف الروم','error')}
    }

    openRoomGiftModal() {
        if (!this.activeRoom || !this.currentUser) return;
        const modal=document.getElementById('zono-room-gift-modal');
        const select=document.getElementById('zono-gift-recipient');
        if(!modal||!select) return;

        const others=this.roomMembers.filter(m=>Number(m.public_id)!==Number(this.currentUser.publicId));
        select.innerHTML=`<option value="all">👥 الجميع (${others.length})</option>`+
            others.map(m=>`<option value="${Number(m.public_id)}">${this.escapeHtml(m.display_name||'')} — ID ${Number(m.public_id)}</option>`).join('');

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    closeRoomGiftModal() {
        const modal=document.getElementById('zono-room-gift-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
    }

    selectGift(key) {
        if(key!=='rose') return;
        this.selectedGift='rose';
        document.getElementById('zono-gift-rose')?.classList.add('is-selected');
    }

    async sendRoomGift() {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        const value=document.getElementById('zono-gift-recipient')?.value;
        if(!value) return this.showToast('اختر المستلم','error');

        try{
            const targetAll=value==='all';
            const {data,error}=await client.rpc('zono_send_room_gift',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_recipient_public_id:targetAll?null:Number(value),
                p_to_all:targetAll,
                p_gift_key:'rose'
            });
            if(error) throw error;

            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            this.updateProfileUI();
            this.closeRoomGiftModal();
            await this.loadRoomMessages(true);

            this.showToast(`تم إرسال 🌹 — التكلفة ${Number(data?.total_cost||100).toLocaleString('en-US')} ريشة`,'success');
        }catch(e){this.showToast(e.message||'تعذر إرسال الهدية','error')}
    }

    updateRoomFavoriteButton() {
        const btn=document.getElementById('zono-room-favorite-btn');
        if(!btn) return;
        const fav=!!this.activeRoom?.is_favorite;
        btn.textContent=fav?'♥':'♡';
        btn.classList.toggle('is-favorite',fav);
        btn.title=fav?'إزالة من المفضلة':'حفظ في المفضلة';
    }

    async toggleRoomFavorite() {
        if(!this.activeRoom) return;
        const client=this.getRoomClient();
        if(!client) return;
        try{
            const {data,error}=await client.rpc('zono_toggle_room_favorite',{
                p_room_public_id:Number(this.activeRoom.public_id)
            });
            if(error) throw error;
            this.activeRoom.is_favorite=!!data?.is_favorite;
            this.updateRoomFavoriteButton();
            this.showToast(this.activeRoom.is_favorite?'تم حفظ الروم في المفضلة':'تمت إزالة الروم من المفضلة','success');
        }catch(e){this.showToast(e.message||'تعذر تحديث المفضلة','error')}
    }

    applyRoomVisuals(room) {
        if (!room) return;
        const bg=document.getElementById('zono-room-background');
        if (bg) {
            const url=room.background_url || room.image_url || '';
            bg.style.backgroundImage=url ? `url("${String(url).replace(/"/g,'%22')}")` : '';
        }
        const text=document.getElementById('zono-room-guidelines-text');
        if (text) text.textContent=room.guidelines_text || 'مرحباً بك؛ يرجى الالتزام بالاحترام، منع السب والإساءة، وعدم نشر محتوى مخالف.';
    }

    async uploadRoomAsset(file,bucket='room-images',prefix='backgrounds') {
        const client=this.getRoomClient();
        if(!client||!file) throw new Error('اختر ملفاً');
        if(!file.type?.startsWith('image/')) throw new Error('الملف يجب أن يكون صورة');
        if(file.size>4*1024*1024) throw new Error('حجم الصورة يجب ألا يتجاوز 4MB');
        const ext=(file.name.split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase();
        const path=`${window.zonoAuth?.user?.id||'user'}/${prefix}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const {error}=await client.storage.from(bucket).upload(path,file,{cacheControl:'3600',upsert:false,contentType:file.type});
        if(error) throw error;
        return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    }

    async saveRoomBackground() {
        if(!this.activeRoom?.is_owner) return;
        const file=document.getElementById('zono-room-background-file')?.files?.[0];
        if(!file) return this.showToast('اختر صورة للخلفية','error');
        const client=this.getRoomClient();
        try{
            this.showToast('جاري رفع الخلفية...','info');
            const url=await this.uploadRoomAsset(file,'room-images','backgrounds');
            const {error}=await client.rpc('zono_room_set_background',{p_room_public_id:Number(this.activeRoom.public_id),p_background_url:url});
            if(error) throw error;
            this.activeRoom.background_url=url;
            this.applyRoomVisuals(this.activeRoom);
            this.showToast('تم تغيير خلفية الغرفة','success');
        }catch(e){this.showToast(e.message||'تعذر تغيير الخلفية','error')}
    }

    async clearRoomBackground() {
        if(!this.activeRoom?.is_owner) return;
        const client=this.getRoomClient();
        try{
            const {error}=await client.rpc('zono_room_set_background',{p_room_public_id:Number(this.activeRoom.public_id),p_background_url:null});
            if(error) throw error;
            this.activeRoom.background_url=null;
            this.applyRoomVisuals(this.activeRoom);
            this.showToast('تم إرجاع الخلفية الافتراضية','success');
        }catch(e){this.showToast(e.message||'تعذر تحديث الخلفية','error')}
    }

    async saveRoomGuidelines() {
        if(!this.activeRoom?.is_owner) return;
        const value=String(document.getElementById('zono-room-guidelines-input')?.value||'').trim();
        if(value.length<5||value.length>500) return this.showToast('الإرشادات يجب أن تكون من 5 إلى 500 حرف','error');
        const client=this.getRoomClient();
        try{
            const {error}=await client.rpc('zono_room_set_guidelines',{p_room_public_id:Number(this.activeRoom.public_id),p_guidelines:value});
            if(error) throw error;
            this.activeRoom.guidelines_text=value;
            this.applyRoomVisuals(this.activeRoom);
            this.showToast('تم حفظ إرشادات المجتمع','success');
        }catch(e){this.showToast(e.message||'تعذر حفظ الإرشادات','error')}
    }

    async buyRoomMicPackage(count) {
        if(String(this.activeRoom?.plan_type||'permanent')==='trial') return this.showToast('شراء المايكات متاح للروم الدائم فقط','error');
        if(!this.activeRoom?.is_owner) return this.showToast('شراء الباقة لمالك الروم فقط','error');
        if(![4,6,8].includes(Number(count))) return;
        const price=Number(count)*1000;
        if(Number(this.currentUser?.seeds||0)<price) return this.showToast(`تحتاج ${price.toLocaleString('en-US')} بذرة`,'error');
        if(!confirm(`شراء باقة ${count} مايك لمدة 60 يوم مقابل ${price.toLocaleString('en-US')} بذرة؟`)) return;
        const client=this.getRoomClient();
        try{
            const {data,error}=await client.rpc('zono_room_buy_mic_package',{p_room_public_id:Number(this.activeRoom.public_id),p_mic_count:Number(count)});
            if(error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            this.updateProfileUI();
            await this.loadRoomMicState();
            this.showToast(`تم تفعيل ${count} مايك لمدة 60 يوم`,'success');
        }catch(e){this.showToast(e.message||'تعذر شراء باقة المايكات','error')}
    }

    async setRoomMicMode(mode) {
        if(!['open','approval','closed'].includes(mode)||!this.activeRoom) return;
        const client=this.getRoomClient();
        try{
            const {error}=await client.rpc('zono_room_set_mic_mode',{p_room_public_id:Number(this.activeRoom.public_id),p_mode:mode});
            if(error) throw error;
            this.activeRoom.mic_mode=mode;
            await this.loadRoomMicState();
            this.showToast('تم تحديث طريقة الصعود للمايك','success');
        }catch(e){this.showToast(e.message||'تعذر تحديث المايكات','error')}
    }

    async loadRoomMicState(showToast=false) {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        try{
            const {data,error}=await client.rpc('zono_room_mic_state',{p_room_public_id:Number(this.activeRoom.public_id)});
            if(error) throw error;
            this.roomMicState=data||null;
            if(data){
                this.activeRoom.mic_count=Number(data.mic_count||0);
                this.activeRoom.mic_mode=data.mic_mode||'open';
                this.activeRoom.mic_expires_at=data.mic_expires_at||null;
            }
            this.renderRoomMics();
            this.renderRoomMicRequests();
            this.renderMicPackageStatus();
            if (window.zonoLiveVoice) {
                window.zonoLiveVoice.syncMicState().catch(()=>{});
            }
            if(showToast) this.showToast('تم تحديث المايكات','success');
        }catch(e){ if(showToast) this.showToast(e.message||'تعذر تحديث المايكات','error') }
    }

    renderMicPackageStatus() {
        const box=document.getElementById('zono-mic-package-current');
        const badge=document.getElementById('room-mic-expiry-badge');
        const state=this.roomMicState;
        if(!state||!state.active){
            if(box) box.textContent='لا توجد باقة فعالة';
            badge?.classList.add('hidden');
            return;
        }
        const days=Math.max(0,Math.ceil((new Date(state.mic_expires_at)-Date.now())/86400000));
        if(box) box.textContent=`الباقة الحالية: ${Number(state.mic_count)} مايك — متبقي ${days} يوم`;
        if(badge){badge.textContent=`🎙️ ${state.mic_count} • ${days}ي`;badge.classList.remove('hidden')}
    }

    renderRoomMics() {
        const zone=document.getElementById('zono-room-mic-zone');
        const box=document.getElementById('zono-room-mic-seats');
        const label=document.getElementById('zono-room-mic-mode-label');
        const btn=document.getElementById('zono-room-mic-request-btn');
        const s=this.roomMicState;
        if(!zone||!box) return;

        if(!s?.active||Number(s.mic_count||0)<1){
            zone.classList.add('hidden');
            return;
        }
        zone.classList.remove('hidden');
        const modeLabels={open:'مباشر',approval:'بموافقة',closed:'مقفلة'};
        if(label) label.textContent=modeLabels[s.mic_mode]||'مباشر';

        const myId=Number(this.currentUser?.publicId||0);
        const mySeat=(s.seats||[]).find(x=>Number(x.user_public_id)===myId);
        if(btn){
            btn.textContent=mySeat?'نزول من المايك':(s.mic_mode==='approval'?'طلب مايك':'صعود للمايك');
            btn.disabled=s.mic_mode==='closed'&&!mySeat;
        }

        const liveMuteBtn=document.getElementById('zono-live-mic-toggle');
        if(liveMuteBtn){
            liveMuteBtn.classList.toggle('hidden',!mySeat);
            if(mySeat){
                const muted=!!window.zonoLiveVoice?.isMuted;
                liveMuteBtn.textContent=muted?'🔇 مكتوم':'🔊 مفتوح';
                liveMuteBtn.classList.toggle('is-muted',muted);
            }
        }

        const seats=Array.isArray(s.seats)?s.seats:[];
        box.innerHTML=Array.from({length:Number(s.mic_count)},(_,i)=>{
            const seatNo=i+1;
            const seat=seats.find(x=>Number(x.seat_no)===seatNo)||{};
            const occupied=!!seat.user_public_id;
            const locked=!!seat.is_locked;
            return `<button data-public-id="${occupied?Number(seat.user_public_id):''}" onclick="window.zonoApp.handleMicSeatClick(${seatNo},${occupied?'true':'false'})" class="zono-mic-seat zono-mic-seat-circle ${occupied?'occupied':''} ${locked?'locked':''}">
                ${occupied
                    ? `<div class="zono-mic-avatar-wrap"><img src="${this.escapeHtml(seat.avatar||'')}" alt=""></div><b>${this.escapeHtml(seat.display_name||'')}</b>`
                    : `<div class="zono-mic-seat-icon">${locked?'🔒':'+'}</div>`}
            </button>`;
        }).join('');
    }

    updateLiveAudioStatus(state='off', text='غير متصل') {
        const el=document.getElementById('zono-live-audio-status');
        if(!el) return;
        el.classList.remove('is-off','is-connecting','is-on','is-error');
        el.classList.add(`is-${state}`);
        el.textContent=`● ${text}`;
    }

    toggleLiveAudioDiagnostics() {
        const panel=document.getElementById('zono-live-audio-diagnostics');
        if(!panel) return;
        panel.classList.toggle('hidden');
        if(!panel.classList.contains('hidden')) this.runLiveAudioDiagnostics();
    }

    async runLiveAudioDiagnostics() {
        if(!window.zonoLiveVoice) return;
        const result=await window.zonoLiveVoice.getDiagnostics();

        const set=(id,text,cls='')=>{
            const el=document.getElementById(id);
            if(!el) return;
            el.textContent=text;
            el.className=cls;
        };

        set('diag-mic',result.microphone.label,result.microphone.ok?'ok':'bad');
        set('diag-realtime',result.realtime.label,result.realtime.ok?'ok':'bad');
        set('diag-webrtc',result.webrtc.label,result.webrtc.ok?'ok':'warn');
        set('diag-ice',result.ice.label,result.ice.ok?'ok':'warn');
        set('diag-remote-audio',result.remoteAudio.label,result.remoteAudio.ok?'ok':'warn');
        set('diag-peer-count',String(result.peerCount),result.peerCount>0?'ok':'warn');

        const msg=document.getElementById('diag-live-message');
        if(msg) msg.textContent=result.summary;
    }

    async toggleLiveMicMute() {
        if(!window.zonoLiveVoice) return;
        const muted=window.zonoLiveVoice.toggleMute();
        const btn=document.getElementById('zono-live-mic-toggle');
        if(btn){
            btn.textContent=muted?'🔇':'🔊';
            btn.classList.toggle('is-muted',muted);
        }
        this.showToast(muted?'تم كتم مايكك':'تم فتح مايكك','success');
    }

    async requestRoomMic() {
        if(!this.activeRoom||!this.roomMicState?.active) return;
        const myId=Number(this.currentUser?.publicId||0);
        const mySeat=(this.roomMicState.seats||[]).find(x=>Number(x.user_public_id)===myId);
        if(mySeat) return this.leaveRoomMic();
        if(this.roomMicState.mic_mode==='closed') return this.showToast('المايكات مقفلة','error');
        const client=this.getRoomClient();
        try{
            const {data,error}=await client.rpc('zono_room_request_mic',{p_room_public_id:Number(this.activeRoom.public_id)});
            if(error) throw error;
            await this.loadRoomMicState();
            this.showToast(data?.status==='seated'?'تم الصعود للمايك':'تم إرسال طلب المايك','success');
        }catch(e){this.showToast(e.message||'تعذر طلب المايك','error')}
    }

    async leaveRoomMic() {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        try{
            const {error}=await client.rpc('zono_room_leave_mic',{p_room_public_id:Number(this.activeRoom.public_id)});
            if(error) throw error;
            await this.loadRoomMicState();
        }catch(e){this.showToast(e.message||'تعذر النزول من المايك','error')}
    }

    handleMicSeatClick(seatNo,occupied) {
        const seat=(this.roomMicState?.seats||[]).find(x=>Number(x.seat_no)===Number(seatNo));
        const myId=Number(this.currentUser?.publicId||0);

        if(occupied){
            if(Number(seat?.user_public_id)===myId) return this.leaveRoomMic();
            if((this.activeRoom?.is_owner||this.activeRoom?.is_moderator) && seat?.user_public_id){
                if(confirm(`إنزال ${seat.display_name||'المستخدم'} من المايك؟`)) {
                    return this.removeMicUser(Number(seat.user_public_id));
                }
            }
            return;
        }

        if(seat?.is_locked){
            if(this.activeRoom?.is_owner||this.activeRoom?.is_moderator) {
                return this.setMicSeatLock(seatNo,false);
            }
            return this.showToast('هذا المايك مقفل','error');
        }

        return this.requestRoomMic();
    }

    async setMicSeatLock(seatNo,locked) {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        try{
            const {error}=await client.rpc('zono_room_mic_set_seat_lock',{p_room_public_id:Number(this.activeRoom.public_id),p_seat_no:Number(seatNo),p_locked:!!locked});
            if(error) throw error;
            await this.loadRoomMicState();
        }catch(e){this.showToast(e.message||'تعذر تحديث المايك','error')}
    }

    async removeMicUser(publicId) {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        try{
            const {error}=await client.rpc('zono_room_mic_remove_user',{p_room_public_id:Number(this.activeRoom.public_id),p_target_public_id:Number(publicId)});
            if(error) throw error;
            await this.loadRoomMicState();
        }catch(e){this.showToast(e.message||'تعذر إنزال المستخدم','error')}
    }

    renderRoomMicRequests() {
        const box=document.getElementById('zono-room-mic-requests');
        if(!box) return;
        const reqs=Array.isArray(this.roomMicState?.requests)?this.roomMicState.requests:[];
        box.innerHTML=reqs.map(r=>`<div class="zono-mic-request-row">
            <div><b>${this.escapeHtml(r.display_name||'')}</b><span>ID ${Number(r.user_public_id)}</span></div>
            <div class="flex gap-1"><button onclick="window.zonoApp.answerMicRequest(${Number(r.user_public_id)},true)">قبول</button><button onclick="window.zonoApp.answerMicRequest(${Number(r.user_public_id)},false)">رفض</button></div>
        </div>`).join('')||'<div class="text-[10px] text-stone-500">لا توجد طلبات حالياً.</div>';
    }

    async answerMicRequest(publicId,approve) {
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;
        try{
            const {error}=await client.rpc('zono_room_mic_request_action',{p_room_public_id:Number(this.activeRoom.public_id),p_target_public_id:Number(publicId),p_approve:!!approve});
            if(error) throw error;
            await this.loadRoomMicState();
        }catch(e){this.showToast(e.message||'تعذر معالجة الطلب','error')}
    }

    formatVoiceDuration(seconds) {
        seconds=Math.max(0,Math.round(Number(seconds)||0));
        return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
    }

    async toggleVoiceRecording() {
        if(this.voiceRecorder?.state==='recording') return this.stopVoiceRecording();
        if(this.recordedVoiceBlob) return this.showToast('أرسل أو ألغِ البصمة الحالية أولاً','info');
        if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder) return this.showToast('التسجيل الصوتي غير مدعوم في هذا المتصفح/التطبيق','error');
        try{
            const stream=await navigator.mediaDevices.getUserMedia({audio:true});
            const preferred=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
            const mime=preferred.find(x=>MediaRecorder.isTypeSupported?.(x))||'';
            this.voiceChunks=[];
            this.voiceStartedAt=Date.now();
            this.voiceRecorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
            this.voiceRecorder.ondataavailable=e=>{if(e.data?.size)this.voiceChunks.push(e.data)};
            this.voiceRecorder.onstop=()=>{
                stream.getTracks().forEach(t=>t.stop());
                const type=this.voiceRecorder?.mimeType||'audio/webm';
                this.recordedVoiceBlob=new Blob(this.voiceChunks,{type});
                this.recordedVoiceUrl=URL.createObjectURL(this.recordedVoiceBlob);
                const seconds=Math.min(60,Math.max(1,Math.round((Date.now()-this.voiceStartedAt)/1000)));
                this.recordedVoiceDuration=seconds;
                document.getElementById('zono-room-voice-duration').textContent=this.formatVoiceDuration(seconds);
                document.getElementById('zono-room-voice-preview')?.classList.remove('hidden');
                const btn=document.getElementById('zono-room-voice-btn'); if(btn){btn.textContent='🎙️';btn.classList.remove('recording')}
            };
            this.voiceRecorder.start(250);
            const btn=document.getElementById('zono-room-voice-btn'); if(btn){btn.textContent='⏹';btn.classList.add('recording')}
            this.voiceMaxTimer=setTimeout(()=>this.stopVoiceRecording(),60000);
        }catch(e){this.showToast('اسمح للتطبيق باستخدام الميكروفون لتسجيل البصمة','error')}
    }

    stopVoiceRecording() {
        clearTimeout(this.voiceMaxTimer);
        if(this.voiceRecorder?.state==='recording') this.voiceRecorder.stop();
    }

    previewRecordedVoice() {
        if(!this.recordedVoiceUrl) return;
        try{
            if(this.previewVoiceAudio){
                this.previewVoiceAudio.pause();
                this.previewVoiceAudio.currentTime=0;
            }
        }catch(_){}
        const audio=new Audio(this.recordedVoiceUrl);
        this.previewVoiceAudio=audio;
        audio.play().catch(()=>this.showToast('تعذر تشغيل المعاينة','error'));
    }

    cancelRecordedVoice() {
        try{
            if(this.previewVoiceAudio){
                this.previewVoiceAudio.pause();
                this.previewVoiceAudio.currentTime=0;
            }
        }catch(_){}
        this.previewVoiceAudio=null;
        if(this.recordedVoiceUrl) URL.revokeObjectURL(this.recordedVoiceUrl);
        this.recordedVoiceUrl=null;this.recordedVoiceBlob=null;this.voiceChunks=[];
        document.getElementById('zono-room-voice-preview')?.classList.add('hidden');
    }

    async sendRecordedVoice() {
        if(this.sendingRecordedVoice) return;
        const client=this.getRoomClient();
        if(!client||!this.activeRoom||!this.recordedVoiceBlob) {
            return this.showToast('لا توجد بصمة جاهزة للإرسال','error');
        }

        this.sendingRecordedVoice=true;
        try{
            // Stop preview first. Keep the Blob alive until upload + DB insert finish.
            try{
                if(this.previewVoiceAudio){
                    this.previewVoiceAudio.pause();
                    this.previewVoiceAudio.currentTime=0;
                }
            }catch(_){}

            const original=this.recordedVoiceBlob;
            if(!original.size) throw new Error('ملف البصمة فارغ');

            const rawType=String(original.type||'audio/webm').toLowerCase();
            let mime='audio/webm',ext='webm';
            if(rawType.includes('mp4')||rawType.includes('m4a')){mime='audio/mp4';ext='m4a'}
            else if(rawType.includes('ogg')){mime='audio/ogg';ext='ogg'}
            else if(rawType.includes('mpeg')||rawType.includes('mp3')){mime='audio/mpeg';ext='mp3'}

            // Normalize MIME (remove codecs suffix) because Storage allowed_mime_types
            // rejects values such as "audio/webm;codecs=opus" on some browsers.
            const uploadBlob=original.type===mime ? original : new Blob([original],{type:mime});
            const uid=window.zonoAuth?.user?.id;
            if(!uid) throw new Error('الحساب غير متصل');

            const roomId=Number(this.activeRoom.public_id);
            const path=`${uid}/${roomId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

            const {error:upErr}=await client.storage.from('room-voice').upload(path,uploadBlob,{
                upsert:false,
                contentType:mime,
                cacheControl:'3600'
            });
            if(upErr) throw upErr;

            const url=client.storage.from('room-voice').getPublicUrl(path).data.publicUrl;
            const duration=Math.max(1,Math.min(60,Number(this.recordedVoiceDuration||1)));

            const {data,error}=await client.rpc('zono_send_room_voice_v2',{
                p_room_public_id:roomId,
                p_media_url:url,
                p_duration:duration
            });

            if(error){
                client.storage.from('room-voice').remove([path]).catch(()=>{});
                throw error;
            }
            if(!data?.ok){
                client.storage.from('room-voice').remove([path]).catch(()=>{});
                throw new Error('لم يتم حفظ البصمة في الروم');
            }

            this.cancelRecordedVoice();
            await this.loadRoomMessages(true);
            this.showToast('تم إرسال البصمة الصوتية','success');
        }catch(e){
            this.showToast(e.message||'تعذر إرسال البصمة الصوتية','error');
        }finally{
            this.sendingRecordedVoice=false;
        }
    }

    toggleVoicePlayback(button,url) {
        if(!url) return;

        // تشغيل بصمة واحدة فقط. الضغط على نفس البصمة يعيدها من البداية.
        if(this.activeVoiceAudio){
            try{ this.activeVoiceAudio.pause(); this.activeVoiceAudio.currentTime=0; }catch(_){}
            if(this.activeVoiceButton){
                this.activeVoiceButton.textContent='▶';
                this.activeVoiceButton.classList.remove('is-playing');
            }
        }

        let a = button._audio;
        if(!a){
            a = new Audio(url);
            button._audio = a;
        }
        try{ a.currentTime=0; }catch(_){}
        this.activeVoiceAudio=a;
        this.activeVoiceButton=button;

        a.onplay=()=>{button.textContent='Ⅱ';button.classList.add('is-playing')};
        a.onpause=()=>{button.textContent='▶';button.classList.remove('is-playing')};
        a.onended=()=>{
            button.textContent='▶';button.classList.remove('is-playing');
            try{a.currentTime=0}catch(_){}
            if(this.activeVoiceAudio===a){this.activeVoiceAudio=null;this.activeVoiceButton=null}
        };
        a.play().catch(()=>this.showToast('تعذر تشغيل الرسالة الصوتية','error'));
    }

    stopActiveVoicePlayback() {
        if(!this.activeVoiceAudio) return;
        try{this.activeVoiceAudio.pause();this.activeVoiceAudio.currentTime=0}catch(_){}
        if(this.activeVoiceButton){this.activeVoiceButton.textContent='▶';this.activeVoiceButton.classList.remove('is-playing')}
        this.activeVoiceAudio=null;this.activeVoiceButton=null;
    }

    ensureRoomMusicAudio() {
        if(this.roomMusicAudio) return this.roomMusicAudio;
        const audio=new Audio();
        audio.preload='auto';
        audio.playsInline=true;
        audio.crossOrigin='anonymous';
        audio.volume=this.roomMusicMuted ? 0 : this.roomMusicVolume;

        audio.onplay=()=>{
            document.getElementById('zono-room-music-fab')?.classList.add('is-playing');
            const main=document.getElementById('zono-music-main-control');
            if(main) main.textContent='Ⅱ';
        };
        audio.onpause=()=>{
            document.getElementById('zono-room-music-fab')?.classList.remove('is-playing');
            const main=document.getElementById('zono-music-main-control');
            if(main) main.textContent='▶';
        };
        audio.ontimeupdate=()=>this.renderRoomMusicProgress();
        audio.onended=()=>{
            // Only room staff changes the shared track. Listeners never change room playback.
            if(this.roomMusicIsStaff) this.roomMusicControl('ended').catch(()=>{});
        };

        this.roomMusicAudio=audio;
        return audio;
    }

    toggleRoomMusicPanel() {
        const panel=document.getElementById('zono-room-music-panel');
        if(!panel) return;
        panel.classList.toggle('hidden');
        if(!panel.classList.contains('hidden')) this.loadRoomMusicState(false);
    }

    formatMediaTime(sec) {
        sec=Math.max(0,Math.floor(Number(sec)||0));
        return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
    }

    async loadRoomMusicState(silent=true) {
        const client=this.getRoomClient();
        if(!client || !this.activeRoom) return;
        try{
            const roomId=Number(this.activeRoom.public_id);
            const {data,error}=await client.rpc('zono_music_library_v2',{p_room_public_id:roomId});
            if(error) throw error;
            // Ignore a late response belonging to a room that was already closed/switched.
            if(!this.activeRoom || Number(this.activeRoom.public_id)!==roomId) return;

            this.roomMusicState=data?.state||null;
            this.roomMusicSongs=Array.isArray(data?.songs)?data.songs:[];
            this.roomMusicIsStaff=!!data?.is_staff;
            this.roomMusicIsOwner=!!data?.is_owner; const bm=document.getElementById('zono-room-bottom-music'); if(bm) bm.classList.toggle('hidden',!this.roomMusicIsStaff);

            this.applyRoomMusicState(data);
            this.renderRoomMusicList();
            this.renderRoomMusicAdminList();
        }catch(e){
            if(!silent) this.showToast(e.message||'تعذر تحميل موسيقى الروم','error');
        }
    }

    applyRoomMusicState(payload) {
        const state=payload?.state||null;
        const audio=this.ensureRoomMusicAudio();

        const controls=document.getElementById('zono-music-staff-controls');
        controls?.classList.toggle('hidden',!this.roomMusicIsStaff);

        const volumeInput=document.getElementById('zono-music-volume');
        if(volumeInput) volumeInput.value=String(Math.round(this.roomMusicVolume*100));
        const volumeLabel=document.getElementById('zono-music-volume-label');
        if(volumeLabel) volumeLabel.textContent=`${Math.round(this.roomMusicVolume*100)}%`;
        const muteBtn=document.getElementById('zono-music-mute-btn');
        if(muteBtn) muteBtn.textContent=this.roomMusicMuted?'🔇':'🔊';

        const title=document.getElementById('zono-music-now-title');

        if(!state?.song_url){
            if(title) title.textContent='لا توجد أغنية تعمل';
            try{
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                delete audio.dataset.songId;
            }catch(_){}
            this.renderRoomMusicProgress();
            return;
        }

        if(title) title.textContent=state.song_title||'موسيقى الروم';

        const changed=audio.dataset.songId!==String(state.song_id);
        if(changed){
            audio.dataset.songId=String(state.song_id);
            audio.src=state.song_url;
            audio.load();
        }

        audio.volume=this.roomMusicMuted ? 0 : this.roomMusicVolume;

        const base=Math.max(0,Number(state.position_seconds||0));
        const serverNow=new Date(state.server_now||Date.now()).getTime();
        const startedAt=state.started_at?new Date(state.started_at).getTime():serverNow;
        const target=state.status==='playing'
            ? base + Math.max(0,(serverNow-startedAt)/1000)
            : base;

        const syncPosition=()=>{
            if(Number.isFinite(target) && Math.abs((audio.currentTime||0)-target)>1.8){
                try{audio.currentTime=Math.min(target,Number.isFinite(audio.duration)?audio.duration:target)}catch(_){}
            }
        };

        if(changed){
            audio.onloadedmetadata=()=>{
                syncPosition();
                if(state.status==='playing') audio.play().catch(()=>{});
                this.renderRoomMusicProgress();
            };
        }else{
            syncPosition();
        }

        if(state.status==='playing'){
            const p=audio.play();
            if(p?.catch) p.catch(()=>{});
        }else{
            audio.pause();
        }

        const repeat=document.getElementById('zono-music-repeat-btn');
        if(repeat) repeat.textContent=state.repeat_mode==='one'?'🔂 تكرار':'🔁 التالي';

        this.renderRoomMusicProgress();
    }

    renderRoomMusicProgress() {
        const audio=this.roomMusicAudio;
        const current=Number(audio?.currentTime||this.roomMusicState?.position_seconds||0);
        const duration=Number(
            (Number.isFinite(audio?.duration) ? audio.duration : 0)
            || this.roomMusicState?.duration_seconds
            || 0
        );
        const pct=duration>0?Math.max(0,Math.min(100,current/duration*100)):0;
        const fill=document.getElementById('zono-music-progress-fill');
        if(fill) fill.style.width=`${pct}%`;

        const cur=document.getElementById('zono-music-current-time');
        const dur=document.getElementById('zono-music-duration');
        if(cur) cur.textContent=this.formatMediaTime(current);
        if(dur) dur.textContent=this.formatMediaTime(duration);
    }

    renderRoomMusicList() {
        const box=document.getElementById('zono-room-music-list');
        if(!box) return;
        const currentId=Number(this.roomMusicState?.song_id||0);

        box.innerHTML=this.roomMusicSongs.map(song=>`
            <div class="zono-music-song ${Number(song.id)===currentId?'is-current':''}">
                <div class="zono-music-song-icon">🎵</div>
                <div class="min-w-0 flex-1">
                    <b>${this.escapeHtml(song.title||'أغنية')}</b>
                    <span>${this.formatMediaTime(song.duration_seconds||0)}</span>
                </div>
                ${this.roomMusicIsStaff
                    ? `<button onclick="window.zonoApp.roomMusicPlaySong(${Number(song.id)})">تشغيل</button>`
                    : ''}
            </div>
        `).join('') || '<div class="text-center text-stone-500 text-[10px] py-4">لم يضف مالك الروم أغاني بعد.</div>';
    }

    renderRoomMusicAdminList() {
        const box=document.getElementById('zono-room-music-admin-list');
        if(!box) return;

        box.innerHTML=this.roomMusicSongs.map(song=>`
            <div class="zono-music-admin-row">
                <div class="min-w-0">
                    <b>${this.escapeHtml(song.title||'أغنية')}</b>
                    <span>${this.formatMediaTime(song.duration_seconds||0)}</span>
                </div>
                <button onclick="window.zonoApp.deleteRoomMusic(${Number(song.id)})">حذف</button>
            </div>
        `).join('') || '<div class="text-[10px] text-stone-500">لا توجد أغاني مرفوعة.</div>';
    }

    getAudioFileDuration(file) {
        return new Promise((resolve,reject)=>{
            const url=URL.createObjectURL(file);
            const audio=document.createElement('audio');
            audio.preload='metadata';
            audio.onloadedmetadata=()=>{
                const duration=Math.max(1,Math.round(audio.duration||0));
                URL.revokeObjectURL(url);
                resolve(duration);
            };
            audio.onerror=()=>{
                URL.revokeObjectURL(url);
                reject(new Error('تعذر قراءة ملف MP3'));
            };
            audio.src=url;
        });
    }

    async uploadRoomMusic() {
        if(String(this.activeRoom?.plan_type||'permanent')==='trial') return this.showToast('رفع الأغاني متاح للروم الدائم فقط','error');
        if(!(this.activeRoom?.is_owner||this.activeRoom?.is_moderator)) return this.showToast('رفع الأغاني للمالك والمشرفين فقط','error');

        const input=document.getElementById('zono-room-music-file');
        const status=document.getElementById('zono-room-music-upload-status');
        const file=input?.files?.[0];
        if(!file) return this.showToast('اختر ملف MP3','error');

        const isMp3=/\.mp3$/i.test(file.name) || ['audio/mpeg','audio/mp3','audio/x-mpeg'].includes(String(file.type||'').toLowerCase());
        if(!isMp3) return this.showToast('المسموح ملفات MP3 فقط','error');
        if(file.size>15*1024*1024) return this.showToast('حجم الأغنية يجب ألا يتجاوز 15MB','error');

        const client=this.getRoomClient();
        let uploadedPath=null;
        try{
            if(status){status.textContent='جاري قراءة ملف MP3...';status.className='zono-music-upload-status is-working'}
            const duration=await this.getAudioFileDuration(file);

            const uid=window.zonoAuth?.user?.id;
            if(!uid) throw new Error('الحساب غير متصل');
            const roomId=Number(this.activeRoom.public_id);
            const safe=(file.name||'song.mp3').replace(/[^a-zA-Z0-9._-]+/g,'_');
            const path=`${uid}/${roomId}/${Date.now()}-${safe}`;
            uploadedPath=path;

            if(status) status.textContent='جاري رفع الأغنية...';
            const {error:uploadError}=await client.storage.from('room-music').upload(path,file,{
                upsert:false,
                contentType:'audio/mpeg',
                cacheControl:'3600'
            });
            if(uploadError) throw uploadError;

            const publicUrl=client.storage.from('room-music').getPublicUrl(path).data.publicUrl;
            const title=file.name.replace(/\.mp3$/i,'').trim()||'أغنية';

            if(status) status.textContent='جاري حفظ الأغنية في الروم...';
            const {data,error}=await client.rpc('zono_music_add_track_v2',{
                p_room_public_id:roomId,
                p_title:title,
                p_url:publicUrl,
                p_storage_path:path,
                p_duration_seconds:Math.max(1,duration)
            });
            if(error) throw error;
            if(!data?.ok || !data?.song_id) throw new Error('تم رفع الملف لكن لم يتم تسجيل الأغنية');

            await this.loadRoomMusicState(true);

            const saved=this.roomMusicSongs.some(s=>Number(s.id)===Number(data.song_id));
            if(!saved) throw new Error('لم تظهر الأغنية بعد الحفظ، أعد فتح الروم مرة واحدة');

            if(input) input.value='';
            if(status){status.textContent='✓ تم حفظ الأغنية في الروم';status.className='zono-music-upload-status is-ok'}
            this.showToast('تمت إضافة الأغنية','success');

            if(window.zonoLiveVoice) window.zonoLiveVoice.broadcastRoomMusicChange?.().catch(()=>{});
        }catch(e){
            if(uploadedPath){
                client.storage.from('room-music').remove([uploadedPath]).catch(()=>{});
            }
            if(status){status.textContent=`خطأ: ${e.message||'تعذر الحفظ'}`;status.className='zono-music-upload-status is-error'}
            this.showToast(e.message||'تعذر رفع الأغنية','error');
        }
    }

    async deleteRoomMusic(songId) {
        if(!this.activeRoom?.is_owner) return;
        if(!confirm('حذف هذه الأغنية من الروم؟')) return;
        const client=this.getRoomClient();

        try{
            const {data,error}=await client.rpc('zono_music_delete_track_v2',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_song_id:Number(songId)
            });
            if(error) throw error;

            if(data?.storage_path){
                client.storage.from('room-music').remove([data.storage_path]).catch(()=>{});
            }

            await this.loadRoomMusicState(true);
            if(window.zonoLiveVoice) window.zonoLiveVoice.broadcastRoomMusicChange?.().catch(()=>{});
        }catch(e){
            this.showToast(e.message||'تعذر حذف الأغنية','error');
        }
    }

    async roomMusicControl(action,songId=null) {
        if(!this.roomMusicIsStaff) return this.showToast('التحكم للمالك والمشرفين فقط','error');
        const client=this.getRoomClient();
        if(!client||!this.activeRoom) return;

        try{
            const {error}=await client.rpc('zono_music_control_v2',{
                p_room_public_id:Number(this.activeRoom.public_id),
                p_action:String(action),
                p_song_id:songId==null?null:Number(songId)
            });
            if(error) throw error;

            await this.loadRoomMusicState(true);
            if(window.zonoLiveVoice) window.zonoLiveVoice.broadcastRoomMusicChange?.().catch(()=>{});
        }catch(e){
            this.showToast(e.message||'تعذر التحكم بالموسيقى','error');
        }
    }

    roomMusicPlaySong(songId) { return this.roomMusicControl('play_song',songId); }
    roomMusicNext() { return this.roomMusicControl('next'); }
    roomMusicPrevious() { return this.roomMusicControl('previous'); }
    roomMusicTogglePlay() {
        return this.roomMusicControl(this.roomMusicState?.status==='playing'?'pause':'resume');
    }
    roomMusicToggleRepeat() {
        return this.roomMusicControl(this.roomMusicState?.repeat_mode==='one'?'repeat_all':'repeat_one');
    }

    setRoomMusicVolume(value) {
        const amount=Math.max(0,Math.min(100,Number(value)||0));
        this.roomMusicVolume=amount/100;
        localStorage.setItem('zono_room_music_volume',String(amount));

        if(this.roomMusicAudio){
            this.roomMusicAudio.volume=this.roomMusicMuted?0:this.roomMusicVolume;
        }

        const label=document.getElementById('zono-music-volume-label');
        if(label) label.textContent=`${amount}%`;
    }

    toggleRoomMusicMute() {
        this.roomMusicMuted=!this.roomMusicMuted;
        localStorage.setItem('zono_room_music_muted',String(this.roomMusicMuted));

        if(this.roomMusicAudio){
            this.roomMusicAudio.volume=this.roomMusicMuted?0:this.roomMusicVolume;
        }

        const button=document.getElementById('zono-music-mute-btn');
        if(button) button.textContent=this.roomMusicMuted?'🔇':'🔊';
    }

    stopRoomMusic() {
        if(this.roomMusicAudio){
            try{
                this.roomMusicAudio.pause();
                this.roomMusicAudio.currentTime=0;
                this.roomMusicAudio.removeAttribute('src');
                this.roomMusicAudio.load();
                delete this.roomMusicAudio.dataset.songId;
            }catch(_){}
        }

        document.getElementById('zono-room-music-fab')?.classList.remove('is-playing');
        document.getElementById('zono-room-music-panel')?.classList.add('hidden');
    }

    async deleteRoomMessage(messageId) {
        if(!(this.activeRoom?.is_owner||this.activeRoom?.is_moderator)) return;
        if(!confirm('حذف هذه الرسالة من الروم؟')) return;
        const client=this.getRoomClient();
        try{
            const {error}=await client.rpc('zono_delete_room_message',{p_room_public_id:Number(this.activeRoom.public_id),p_message_id:Number(messageId)});
            if(error) throw error;
            await this.loadRoomMessages(true);
        }catch(e){this.showToast(e.message||'تعذر حذف الرسالة','error')}
    }

    requestRoomExit(fromHistory=false) {
        if(!this.activeRoom) return this.closeRoomModal();
        this._roomExitFromHistory=!!fromHistory;

        const modal=document.getElementById('zono-room-exit-modal');
        const name=document.getElementById('zono-room-exit-name');
        if(name) name.textContent=this.activeRoom.name||'الغرفة';

        modal?.classList.remove('hidden');
        modal?.classList.add('flex');
    }

    closeRoomExitModal() {
        const modal=document.getElementById('zono-room-exit-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
        if(this.activeRoom && this._roomExitFromHistory){
            history.pushState({zonoRoomOpen:true,roomId:Number(this.activeRoom.public_id)},'',location.href);
            this._roomHistoryArmed=true;
        }
        this._roomExitFromHistory=false;
    }

    confirmRoomExit() {
        const modal=document.getElementById('zono-room-exit-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
        this._roomExitFromHistory=false;
        this.closeRoomModal();
    }

    closeRoomModal() {
        const modal=document.getElementById('room-chat-modal');
        if(modal) modal.classList.add('hidden');
        this.closeRoomOwnerInfo?.();
        this.closeRoomMembersPanel?.();
        document.getElementById('zono-room-emoji-panel')?.classList.add('hidden');
        this._roomHistoryArmed=false;
        clearInterval(this.roomPollTimer);
        clearInterval(this.roomPresenceTimer);
        this.roomPollTimer=null;
        this.roomPresenceTimer=null;
        if(this.voiceRecorder?.state==='recording') this.stopVoiceRecording();
        this.cancelRecordedVoice();
        this.stopActiveVoicePlayback();
        this.stopRoomMusic();
        this.roomMusicState=null;
        this.roomMusicSongs=[];
        this.roomInitialMessagesLoaded=false;
        this.roomMicState=null;
        if(window.zonoLiveVoice) window.zonoLiveVoice.leaveRoom().catch(()=>{});

        const roomId=this.activeRoom?.public_id;
        this.activeRoom=null;

        const client=this.getRoomClient();
        if(client&&roomId){
            client.rpc('zono_leave_room',{p_room_public_id:Number(roomId)}).catch(()=>{});
        }
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
                    ${isMe ? `<div class="zono-dm-self-head">${this.avatarFrameHTML('zono-dm-avatar')}<span class="zono-name-capsule ${this.getNameThemeClass()}">${this.escapeHtml(this.currentUser?.displayName || 'أنا')}</span></div>` : ''}
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
            const rewardSeeds = Number(data?.reward || 0);
            this.showToast(`اكتملت الرحلة اليومية: +${rewardSeeds} بذرة 🌾`, 'success');
            await this.recordActivity('counter_seed_reward', 'seed', rewardSeeds, 'مكافأة العداد', 'بذور من رحلة العصفور');
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
            const rewardFeathers = Number(data?.reward || 60);
            this.showToast(`تم استلام مكافأة اليوم: +${rewardFeathers} ريشة 🪶✨`, 'success');
            await this.recordActivity('counter_feather_reward', 'feather', rewardFeathers, 'مكافأة الريش', 'ريش من العداد');
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


    // --- Seed transfers + notifications ---
    async sendSeeds() {
        if (!this.currentUser || !['developer','agent'].includes(this.currentUser.role)) {
            this.showToast('هذه الميزة للمطور والوكيل فقط', 'error');
            return;
        }
        const idEl = document.getElementById('seed-transfer-recipient');
        const amountEl = document.getElementById('seed-transfer-amount');
        const recipientId = Number(String(idEl?.value || '').replace(/\D/g,''));
        const amount = Number(String(amountEl?.value || '').replace(/\D/g,''));
        if (!Number.isInteger(recipientId) || recipientId < 1 || !Number.isInteger(amount) || amount < 1) {
            this.showToast('أدخل ID صحيح وعدد بذور صحيح', 'error');
            return;
        }
        try {
            const { data, error } = await window.zunoBackend.client.rpc('zono_transfer_seeds', {
                p_recipient_public_id: recipientId,
                p_amount: amount
            });
            if (error) throw error;
            await window.zonoAuth.loadProfile(window.zonoAuth.user);
            await this.syncUserFromSupabase();
            if (idEl) idEl.value = '';
            if (amountEl) amountEl.value = '';
            this.showToast(`تم إرسال ${Number(amount).toLocaleString('en-US')} بذرة إلى ID ${recipientId}`, 'success');
            await this.loadNotifications();
        } catch (e) {
            this.showToast(e.message || 'تعذر إرسال البذور', 'error');
        }
    }


    escapeHtml(value = '') {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async loadNotifications(primeOnly = false) {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client || !this.currentUser?.id) return;

        try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

            // Read the receiver's notifications directly from the table.
            // RLS in Supabase guarantees that each user can only read their own rows.
            const { data, error } = await client
                .from('zono_notifications')
                .select('id,user_id,kind,title,body,sender_public_id,amount,is_read,created_at')
                .eq('user_id', this.currentUser.id)
                .gte('created_at', sevenDaysAgo)
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) throw error;

            const allowedKinds = new Set([
                'seed_transfer',
                'support',
                'developer_message',
                'company_message',
                'withdrawal_status',
                'agency_status'
            ]);

            const rows = (Array.isArray(data) ? data : []).filter(n => {
                const kind = String(n.kind || '');
                const looksLikeSeedTransfer =
                    Number(n.amount || 0) > 0 &&
                    Number(n.sender_public_id || 0) > 0;
                return allowedKinds.has(kind) || looksLikeSeedTransfer;
            });

            this.notificationRows = rows;

            const unread = rows.filter(x => !x.is_read).length;
            const newestId = rows.length
                ? Math.max(...rows.map(x => Number(x.id || 0)))
                : 0;

            ['header-profile-notification-count', 'profile-notification-count'].forEach(id => {
                const badge = document.getElementById(id);
                if (!badge) return;
                badge.textContent = unread > 99 ? '99+' : String(unread);
                badge.classList.toggle('hidden', unread === 0);
                badge.classList.toggle('flex', unread > 0);
            });

            const list = document.getElementById('zono-notifications-list');

            if (list) {
                list.innerHTML = rows.length ? rows.map(n => {
                    const looksLikeSeedTransfer =
                        n.kind === 'seed_transfer' ||
                        (Number(n.amount || 0) > 0 && Number(n.sender_public_id || 0) > 0);

                    const icon =
                        looksLikeSeedTransfer ? '🌾' :
                        n.kind === 'support' ? '🛟' :
                        n.kind === 'developer_message' ? '👑' :
                        n.kind === 'withdrawal_status' ? '💸' :
                        n.kind === 'agency_status' ? '🛡️' : '🏢';

                    const title = n.title ||
                        (looksLikeSeedTransfer ? 'استلام بذور' : 'إشعار');

                    return `
                        <button type="button"
                                onclick="window.zonoApp.openNotificationDetail(${Number(n.id || 0)})"
                                class="zono-account-notification-card block ${n.is_read ? 'border border-stone-800 bg-stone-900/55' : 'border border-amber-500/40 bg-amber-950/20'}">
                            <div class="flex items-start gap-2.5">
                                <div class="zono-n-icon shrink-0 bg-stone-950/80 border border-stone-800 flex items-center justify-center text-base">${icon}</div>
                                <div class="min-w-0 flex-1">
                                    <div class="flex items-center justify-between gap-2">
                                        <strong class="zono-n-title text-stone-100">${this.escapeHtml(title)}</strong>
                                        ${n.is_read ? '' : '<span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>'}
                                    </div>
                                    <p class="zono-n-preview text-stone-400">${this.escapeHtml(n.body || '')}</p>
                                    <small class="zono-n-time block text-stone-500">${new Date(n.created_at).toLocaleString('ar-IQ')}</small>
                                </div>
                            </div>
                        </button>`;
                }).join('') : '<div class="text-center text-stone-500 text-xs py-5">لا توجد إشعارات</div>';
            }

            const storageKey = `zono_last_notification_${this.currentUser.username || this.currentUser.id}`;
            const storedId = Number(localStorage.getItem(storageKey) || 0);

            if (!this.notificationsPrimed) {
                this.notificationsPrimed = true;
                this.lastNotificationId = storedId;

                const newestUnread = rows.find(
                    n => !n.is_read && Number(n.id || 0) > storedId
                );

                if (newestUnread) this.showIncomingNotification(newestUnread);

                if (newestId > storedId) {
                    localStorage.setItem(storageKey, String(newestId));
                    this.lastNotificationId = newestId;
                }
                return;
            }

            const newRows = rows
                .filter(n => !n.is_read && Number(n.id || 0) > this.lastNotificationId)
                .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));

            for (const n of newRows) {
                this.showIncomingNotification(n);
            }

            if (newestId > this.lastNotificationId) {
                this.lastNotificationId = newestId;
                localStorage.setItem(storageKey, String(newestId));
            }
        } catch (e) {
            console.error('ZONO notifications:', e);
        }
    }

    openAccountCenter(mode = 'notifications') {
        this.switchTab('profile');
        this.switchAccountCenter(mode);
        setTimeout(() => {
            document.getElementById('zono-account-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
    }

    async switchAccountCenter(mode = 'notifications') {
        const notifications = mode !== 'history';
        document.getElementById('account-center-notifications')?.classList.toggle('hidden', !notifications);
        document.getElementById('account-center-history')?.classList.toggle('hidden', notifications);

        const nBtn = document.getElementById('account-center-tab-notifications');
        const hBtn = document.getElementById('account-center-tab-history');

        if (nBtn) {
            nBtn.classList.toggle('bg-amber-500/20', notifications);
            nBtn.classList.toggle('text-amber-300', notifications);
            nBtn.classList.toggle('border-amber-500/30', notifications);
            nBtn.classList.toggle('text-stone-400', !notifications);
        }
        if (hBtn) {
            hBtn.classList.toggle('bg-amber-500/20', !notifications);
            hBtn.classList.toggle('text-amber-300', !notifications);
            hBtn.classList.toggle('border-amber-500/30', !notifications);
            hBtn.classList.toggle('text-stone-400', notifications);
        }

        if (notifications) await this.loadNotifications(false);
        else await this.loadActivityHistory();
    }

    async openNotificationDetail(notificationId) {
        const n = (this.notificationRows || []).find(x => Number(x.id || 0) === Number(notificationId));
        if (!n) return;

        const icon =
            n.kind === 'seed_transfer' ? '🌾' :
            n.kind === 'support' ? '🛟' :
            n.kind === 'developer_message' ? '👑' : '🏢';

        const modal = document.getElementById('zono-notification-detail-modal');
        const iconEl = document.getElementById('notification-detail-icon');
        const titleEl = document.getElementById('notification-detail-title');
        const timeEl = document.getElementById('notification-detail-time');
        const bodyEl = document.getElementById('notification-detail-body');

        if (iconEl) iconEl.textContent = icon;
        if (titleEl) titleEl.textContent = n.title || 'إشعار';
        if (timeEl) timeEl.textContent = new Date(n.created_at).toLocaleString('ar-IQ');
        if (bodyEl) bodyEl.textContent = n.body || '';

        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        if (!n.is_read) {
            try {
                const client = window.zunoBackend?.client || window.zunoAuth?.client;
                const { error } = await client
                    .from('zono_notifications')
                    .update({ is_read: true })
                    .eq('id', Number(n.id))
                    .eq('user_id', this.currentUser.id);

                if (!error) {
                    n.is_read = true;
                    await this.loadNotifications(false);
                }
            } catch (_) {}
        }
    }

    closeNotificationDetail() {
        const modal = document.getElementById('zono-notification-detail-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    async recordActivity(kind, resource, amount, title, detail = '') {
        if (!window.zunoBackend?.client || !this.currentUser) return;
        try {
            await window.zunoBackend.client.rpc('zono_add_activity_log', {
                p_kind: String(kind || 'activity'),
                p_resource: String(resource || 'seed'),
                p_amount: Number(amount || 0),
                p_title: String(title || 'عملية'),
                p_detail: String(detail || '')
            });
        } catch (_) {}
    }

    async switchHistoryPeriod(period = 'day') {
        this.historyPeriod = period === 'week' ? 'week' : 'day';
        const day = this.historyPeriod === 'day';

        const dayBtn = document.getElementById('history-period-day');
        const weekBtn = document.getElementById('history-period-week');

        if (dayBtn) {
            dayBtn.classList.toggle('bg-emerald-500/15', day);
            dayBtn.classList.toggle('text-emerald-300', day);
            dayBtn.classList.toggle('border-emerald-500/30', day);
            dayBtn.classList.toggle('text-stone-400', !day);
        }
        if (weekBtn) {
            weekBtn.classList.toggle('bg-emerald-500/15', !day);
            weekBtn.classList.toggle('text-emerald-300', !day);
            weekBtn.classList.toggle('border-emerald-500/30', !day);
            weekBtn.classList.toggle('text-stone-400', day);
        }

        await this.loadActivityHistory();
    }

    async loadActivityHistory() {
        const list = document.getElementById('zono-activity-history-list');
        if (!list || !window.zunoBackend?.client || !this.currentUser) return;

        let activities = [];
        try {
            const { data, error } = await window.zunoBackend.client.rpc('zono_my_activity_log');
            if (!error && Array.isArray(data)) activities = data;
        } catch (_) {}

        const allowedKinds = new Set(['counter_seed_reward','counter_feather_reward']);
        let rows = activities.filter(x => allowedKinds.has(String(x.kind || '')));

        const now = new Date();
        const hours = (this.historyPeriod || 'day') === 'week' ? 24 * 7 : 24;
        const threshold = new Date(now.getTime() - hours * 60 * 60 * 1000);

        rows = rows
            .filter(x => new Date(x.created_at) >= threshold)
            .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

        list.innerHTML = rows.length ? rows.map(row => {
            const icon = row.resource === 'seed' ? '🌾' : '🪶';
            const amount = Number(row.amount || 0);
            return `
                <div class="p-2.5 rounded-xl bg-stone-900/55 border border-stone-800">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <strong class="text-[11px] text-stone-100">${icon} ${this.escapeHtml(row.title || 'مكافأة العداد')}</strong>
                            <small class="block text-[9px] text-stone-500 mt-1">${new Date(row.created_at).toLocaleString('ar-IQ')}</small>
                        </div>
                        <div class="shrink-0 font-mono text-sm font-black text-emerald-400">+${amount.toLocaleString('en-US')}</div>
                    </div>
                </div>`;
        }).join('') : `<div class="text-center text-stone-500 text-xs py-5">لا توجد عمليات خلال ${(this.historyPeriod || 'day') === 'week' ? 'الأسبوع' : 'اليوم'}</div>`;
    }

    showIncomingNotification(n) {
        if (!n) return;

        const amount = Number(n.amount || 0);
        let message = n.body || n.title || 'إشعار جديد';

        if (n.kind === 'seed_transfer') {
            message = `🌾 استلمت ${amount.toLocaleString('en-US')} بذرة\n${n.body || ''}`;
            if (window.zonoAudio?.enabled) window.zonoAudio.playTap?.();
            this.showToast(message, 'success');

            // Refresh receiver balance immediately after a seed transfer.
            setTimeout(async () => {
                try {
                    await window.zonoAuth.loadProfile(window.zonoAuth.user);
                    await this.syncUserFromSupabase();
                } catch (_) {}
            }, 250);
        } else if (n.kind === 'private_message') {
            this.showToast(`💬 ${message}`, 'info');
        } else {
            this.showToast(message, 'info');
        }
    }

    async getCurrentBanStatus() {
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        const userId = window.zonoAuth?.user?.id || this.currentUser?.id;
        if (!client || !userId) return { banned: false };

        const { data, error } = await client
            .from('profiles')
            .select('is_banned, banned_until, ban_reason')
            .eq('id', userId)
            .single();

        if (error || !data) return { banned: false };

        const now = Date.now();
        const until = data.banned_until ? new Date(data.banned_until).getTime() : null;
        const banned = data.is_banned === true && (until === null || until > now);
        return {
            banned,
            until,
            reason: String(data.ban_reason || '').trim()
        };
    }

    async enforceCurrentUserBan() {
        try {
            const status = await this.getCurrentBanStatus();
            if (!status.banned) return false;

            if (this.notificationWatcher) {
                clearInterval(this.notificationWatcher);
                this.notificationWatcher = null;
            }
            if (this.banWatcher) {
                clearInterval(this.banWatcher);
                this.banWatcher = null;
            }

            let message = 'تم حظر حسابك من منصة ZONO.';
            if (status.until) {
                const mins = Math.max(1, Math.ceil((status.until - Date.now()) / 60000));
                message = `تم حظر حسابك مؤقتاً. المتبقي تقريباً ${mins} دقيقة.`;
            }

            try { await window.zonoAuth?.logout?.(); } catch (_) {}
            this.currentUser = null;
            this.showAuthModal();
            this.authTab('login');
            this.showBanCapsule(status.reason || '', status.until || null);
            this.showToast(message, 'error');
            return true;
        } catch (_) {
            return false;
        }
    }

    startBanWatcher() {
        if (this.banWatcher) clearInterval(this.banWatcher);
        this.banWatcher = setInterval(async () => {
            if (!this.currentUser) return;
            await this.enforceCurrentUserBan();
        }, 5000);
    }

    startNotificationWatcher() {
        if (this.notificationWatcher) clearInterval(this.notificationWatcher);
        this.notificationWatcher = setInterval(() => {
            if (document.visibilityState === 'visible' && this.currentUser) {
                this.loadNotifications(false);
            }
        }, 5000);
    }

    toggleNotifications() {
        this.openAccountCenter('notifications');
    }

    async markNotificationsRead() {
        const client = window.zunoBackend?.client || window.zunoAuth?.client;
        if (!client || !this.currentUser?.id) return;

        try {
            const { error } = await client
                .from('zono_notifications')
                .update({ is_read: true })
                .eq('user_id', this.currentUser.id)
                .eq('is_read', false);

            if (error) throw error;
            await this.loadNotifications(false);
        } catch (e) {
            this.showToast('تعذر تحديث الإشعارات', 'error');
        }
    }

    showToast(message, type = 'info') {
        const toastEl = document.getElementById('zono-toast');
        if (!toastEl) return;

        toastEl.textContent = message;
        toastEl.style.whiteSpace = 'pre-line';
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

    // --- Developer account ban / unban control ---
    openDeveloperBanModal() {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('هذه الميزة للمطور فقط', 'error');
        }

        const modal = document.getElementById('developer-ban-modal');
        if (!modal) return;

        const idInput = document.getElementById('developer-ban-public-id');
        const reasonInput = document.getElementById('developer-ban-reason');
        const durationInput = document.getElementById('developer-ban-duration');
        const customAmount = document.getElementById('developer-ban-custom-amount');
        const customUnit = document.getElementById('developer-ban-custom-unit');
        const summary = document.getElementById('developer-ban-summary');

        if (idInput) idInput.value = '';
        if (reasonInput) reasonInput.value = '';
        if (durationInput) durationInput.value = 'day';
        if (customAmount) customAmount.value = '';
        if (customUnit) customUnit.value = 'hour';
        if (summary) summary.textContent = 'أدخل ID المستخدم وحدد مدة وسبب الحظر.';
        this.toggleDeveloperCustomDuration();

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => idInput?.focus(), 50);
    }

    closeDeveloperBanModal() {
        const modal = document.getElementById('developer-ban-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    toggleDeveloperCustomDuration() {
        const duration = String(document.getElementById('developer-ban-duration')?.value || 'day');
        const custom = document.getElementById('developer-ban-custom-duration');
        if (custom) custom.classList.toggle('hidden', duration !== 'custom');
    }

    getDeveloperBanDurationLabel() {
        const duration = String(document.getElementById('developer-ban-duration')?.value || 'day');
        if (duration !== 'custom') {
            return ({ day: 'يوم واحد', month: 'شهر واحد', year: 'سنة واحدة' })[duration] || 'يوم واحد';
        }
        const amount = Number(document.getElementById('developer-ban-custom-amount')?.value || 0);
        const unit = String(document.getElementById('developer-ban-custom-unit')?.value || 'hour');
        const units = { minute: 'دقيقة', hour: 'ساعة', day: 'يوم', month: 'شهر', year: 'سنة' };
        return amount > 0 ? `${amount} ${units[unit] || 'ساعة'}` : 'مدة مخصصة غير محددة';
    }

    updateDeveloperBanSummary() {
        const publicId = Number(String(document.getElementById('developer-ban-public-id')?.value || '').replace(/\D/g, ''));
        const reason = String(document.getElementById('developer-ban-reason')?.value || '').trim();
        const summary = document.getElementById('developer-ban-summary');
        if (!summary) return;

        const idText = Number.isInteger(publicId) && publicId > 0 ? `ID ${publicId}` : 'ID غير محدد';
        const reasonText = reason ? ` — السبب: ${reason}` : ' — لم يُكتب سبب بعد';
        summary.textContent = `${idText} • مدة الحظر: ${this.getDeveloperBanDurationLabel()}${reasonText}`;
    }

    async submitDeveloperBan() {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('هذه الميزة للمطور فقط', 'error');
        }

        const client = window.zonoAuth?.client || window.zunoBackend?.client;
        if (!client) return this.showToast('تعذر الاتصال بالخادم', 'error');

        const publicId = Number(String(document.getElementById('developer-ban-public-id')?.value || '').replace(/\D/g, ''));
        const duration = String(document.getElementById('developer-ban-duration')?.value || 'day');
        const customAmount = Number(document.getElementById('developer-ban-custom-amount')?.value || 0);
        const customUnit = String(document.getElementById('developer-ban-custom-unit')?.value || 'hour');
        const reason = String(document.getElementById('developer-ban-reason')?.value || '').trim();
        const submitBtn = document.getElementById('developer-ban-submit');

        if (!Number.isInteger(publicId) || publicId < 1) {
            return this.showToast('أدخل ID حساب صحيح', 'error');
        }
        if (!['day','month','year','custom'].includes(duration)) {
            return this.showToast('اختر مدة حظر صحيحة', 'error');
        }
        if (duration === 'custom') {
            if (!Number.isInteger(customAmount) || customAmount < 1 || customAmount > 9999) {
                return this.showToast('اكتب مدة مخصصة صحيحة من 1 إلى 9999', 'error');
            }
            if (!['minute','hour','day','month','year'].includes(customUnit)) {
                return this.showToast('اختر وحدة المدة المخصصة', 'error');
            }
        }
        if (reason.length < 3) {
            return this.showToast('اكتب سبب الحظر', 'error');
        }
        if (publicId === Number(this.currentUser.publicId || 0)) {
            return this.showToast('لا يمكنك حظر حساب المطور نفسه', 'error');
        }

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'جاري الحظر...';
            }

            const { data, error } = await client.rpc('zono_developer_ban_user', {
                p_public_id: publicId,
                p_duration: duration,
                p_reason: reason,
                p_custom_amount: duration === 'custom' ? customAmount : null,
                p_custom_unit: duration === 'custom' ? customUnit : null
            });

            if (error) throw error;
            if (!data?.ok) throw new Error(data?.message || 'تعذر حظر المستخدم');

            this.closeDeveloperBanModal();
            this.showToast(`تم حظر ID ${publicId} لمدة ${data.duration_label || this.getDeveloperBanDurationLabel()}`.trim(), 'success');
        } catch (e) {
            const raw = String(e?.message || 'تعذر حظر المستخدم');
            const friendly = raw.includes('DEVELOPER_ONLY') ? 'هذه العملية للمطور فقط'
                : raw.includes('USER_NOT_FOUND') ? 'لا يوجد حساب بهذا ID'
                : raw.includes('CANNOT_BAN_SELF') ? 'لا يمكنك حظر حساب المطور نفسه'
                : raw.includes('INVALID_DURATION') ? 'مدة الحظر غير صحيحة'
                : raw.includes('INVALID_CUSTOM_DURATION') ? 'المدة المخصصة غير صحيحة'
                : raw.includes('REASON_REQUIRED') ? 'سبب الحظر مطلوب'
                : raw;
            this.showToast(friendly, 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'متابعة وحظر المستخدم';
            }
        }
    }

    openDeveloperUnbanModal() {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('هذه الميزة للمطور فقط', 'error');
        }
        const modal = document.getElementById('developer-unban-modal');
        if (!modal) return;
        const idInput = document.getElementById('developer-unban-public-id');
        const noteInput = document.getElementById('developer-unban-note');
        const summary = document.getElementById('developer-unban-summary');
        if (idInput) idInput.value = '';
        if (noteInput) noteInput.value = '';
        if (summary) summary.textContent = 'أدخل ID المستخدم لإلغاء الحظر وفتح الحساب.';
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => idInput?.focus(), 50);
    }

    closeDeveloperUnbanModal() {
        const modal = document.getElementById('developer-unban-modal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    updateDeveloperUnbanSummary() {
        const publicId = Number(String(document.getElementById('developer-unban-public-id')?.value || '').replace(/\D/g, ''));
        const note = String(document.getElementById('developer-unban-note')?.value || '').trim();
        const summary = document.getElementById('developer-unban-summary');
        if (!summary) return;
        const idText = Number.isInteger(publicId) && publicId > 0 ? `ID ${publicId}` : 'ID غير محدد';
        const noteText = note ? ` — تنبيه: ${note}` : ' — بدون نبذة تحذيرية';
        summary.textContent = `${idText} • سيتم إلغاء الحظر وفتح الحساب فوراً${noteText}`;
    }

    async submitDeveloperUnban() {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('هذه الميزة للمطور فقط', 'error');
        }
        const client = window.zonoAuth?.client || window.zunoBackend?.client;
        if (!client) return this.showToast('تعذر الاتصال بالخادم', 'error');

        const publicId = Number(String(document.getElementById('developer-unban-public-id')?.value || '').replace(/\D/g, ''));
        const note = String(document.getElementById('developer-unban-note')?.value || '').trim();
        const submitBtn = document.getElementById('developer-unban-submit');
        if (!Number.isInteger(publicId) || publicId < 1) {
            return this.showToast('أدخل ID حساب صحيح', 'error');
        }

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'جاري إلغاء الحظر...';
            }
            const { data, error } = await client.rpc('zono_developer_unban_user', {
                p_public_id: publicId,
                p_note: note || null
            });
            if (error) throw error;
            if (!data?.ok) throw new Error(data?.message || 'تعذر إلغاء الحظر');
            this.closeDeveloperUnbanModal();
            this.showToast(`تم إلغاء حظر ID ${publicId} وفتح الحساب`, 'success');
        } catch (e) {
            const raw = String(e?.message || 'تعذر إلغاء الحظر');
            const friendly = raw.includes('DEVELOPER_ONLY') ? 'هذه العملية للمطور فقط'
                : raw.includes('USER_NOT_FOUND') ? 'لا يوجد حساب بهذا ID'
                : raw;
            this.showToast(friendly, 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'إلغاء الحظر وفتح الحساب';
            }
        }
    }

    // --- Edit Profile ---
    openEditProfileModal() {
        if (!this.currentUser) return;
        const modal = document.getElementById('edit-profile-modal');
        const nameInput = document.getElementById('edit-display-name-input');
        const bioInput = document.getElementById('edit-bio-input');
        const avatarPreview=document.getElementById('edit-avatar-preview');
        const avatarFile=document.getElementById('edit-avatar-file');

        if (nameInput) nameInput.value = this.currentUser.displayName;
        if (bioInput) bioInput.value = this.currentUser.bio;
        if (avatarPreview) avatarPreview.src=this.currentUser.avatar || '';
        if (avatarFile) {
            avatarFile.value='';
            if(!avatarFile.dataset.bound){
                avatarFile.dataset.bound='1';
                avatarFile.addEventListener('change',()=>{
                    const f=avatarFile.files?.[0];
                    if(f&&avatarPreview) avatarPreview.src=URL.createObjectURL(f);
                });
            }
        }
        if (modal) modal.classList.remove('hidden');
    }

    async uploadProfileAvatar(file) {
        const client=window.zonoAuth?.client || window.zunoBackend?.client;
        if(!client||!file) return null;
        if(!file.type?.startsWith('image/')) throw new Error('اختر صورة صحيحة');
        if(file.size>4*1024*1024) throw new Error('حجم الصورة يجب ألا يتجاوز 4MB');

        const ext=(file.name.split('.').pop()||'jpg').replace(/[^a-z0-9]/gi,'').toLowerCase();
        const uid=window.zonoAuth?.user?.id;
        if(!uid) throw new Error('الحساب غير متصل');

        const path=`${uid}/${Date.now()}.${ext}`;
        const {error:upErr}=await client.storage.from('profile-avatars').upload(path,file,{
            upsert:false,cacheControl:'3600',contentType:file.type
        });
        if(upErr) throw upErr;

        const url=client.storage.from('profile-avatars').getPublicUrl(path).data.publicUrl;
        const {error}=await client.rpc('zono_update_avatar',{p_avatar_url:url});
        if(error) throw error;
        return url;
    }

    async saveEditedProfile() {
        if (!this.currentUser) return;
        const nameInput = document.getElementById('edit-display-name-input');
        const bioInput = document.getElementById('edit-bio-input');
        const avatarFile=document.getElementById('edit-avatar-file')?.files?.[0];

        try {
            if(avatarFile) await this.uploadProfileAvatar(avatarFile);
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


    // --- Developer protected account query console ---
    async openDeveloperQueryModal() {
        if (!this.currentUser || this.currentUser.role !== 'developer') {
            return this.showToast('هذه المنطقة للمطور فقط', 'error');
        }
        const modal = document.getElementById('developer-query-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        this.developerQueryToken = null;
        this.developerQuerySelectedId = null;
        await this.prepareDeveloperQueryLock();
    }

    async prepareDeveloperQueryLock() {
        const lockView = document.getElementById('developer-query-lock-view');
        const consoleView = document.getElementById('developer-query-console-view');
        const pin = document.getElementById('developer-query-pin');
        const confirmPin = document.getElementById('developer-query-pin-confirm');
        const btn = document.getElementById('developer-query-unlock-btn');
        const title = document.getElementById('developer-query-lock-title');
        const hint = document.getElementById('developer-query-lock-hint');
        const status = document.getElementById('developer-query-lock-status');
        lockView?.classList.remove('hidden');
        consoleView?.classList.add('hidden');
        if (pin) pin.value = '';
        if (confirmPin) confirmPin.value = '';
        if (status) status.textContent = '';

        try {
            const client = window.zonoBackend?.client || window.zonoAuth?.client;
            if (!client) throw new Error('تعذر الاتصال');
            const { data, error } = await client.rpc('zono_developer_console_status');
            if (error) throw error;
            this.developerQueryNeedsSetup = !data?.configured;
            if (this.developerQueryNeedsSetup) {
                if (title) title.textContent = 'إنشاء رمز حماية لأول مرة';
                if (hint) hint.textContent = 'أنشئ رمزاً سرياً من 6 إلى 32 حرفاً. لا يتم حفظه داخل ملفات الموقع.';
                confirmPin?.classList.remove('hidden');
                if (btn) btn.textContent = 'حفظ الرمز وفتح القفل';
            } else {
                if (title) title.textContent = data?.locked ? 'القفل مؤقتاً بسبب محاولات خاطئة' : 'المنطقة مقفلة';
                if (hint) hint.textContent = data?.locked
                    ? `حاول لاحقاً${data?.locked_until ? ` — حتى ${new Date(data.locked_until).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})}` : ''}`
                    : 'أدخل رمز الحماية الثانوي للمتابعة.';
                confirmPin?.classList.add('hidden');
                if (btn) btn.textContent = 'فتح القفل';
                if (btn) btn.disabled = !!data?.locked;
            }
        } catch (e) {
            if (status) status.textContent = e.message || 'تعذر فحص حالة القفل';
        }
        setTimeout(() => pin?.focus(), 80);
    }

    async unlockDeveloperQueryConsole() {
        if (!this.currentUser || this.currentUser.role !== 'developer') return;
        const pinEl = document.getElementById('developer-query-pin');
        const confirmEl = document.getElementById('developer-query-pin-confirm');
        const btn = document.getElementById('developer-query-unlock-btn');
        const status = document.getElementById('developer-query-lock-status');
        const pin = String(pinEl?.value || '');
        if (pin.length < 6 || pin.length > 32) {
            if (status) status.textContent = 'رمز الحماية يجب أن يكون من 6 إلى 32 حرفاً';
            return;
        }
        if (this.developerQueryNeedsSetup && pin !== String(confirmEl?.value || '')) {
            if (status) status.textContent = 'تأكيد رمز الحماية غير مطابق';
            return;
        }
        const client = window.zonoBackend?.client || window.zonoAuth?.client;
        if (!client) return;
        try {
            if (btn) btn.disabled = true;
            if (status) status.textContent = 'جارٍ التحقق...';
            if (this.developerQueryNeedsSetup) {
                const { error: setupError } = await client.rpc('zono_developer_console_set_pin', { p_pin: pin });
                if (setupError) throw setupError;
            }
            const { data, error } = await client.rpc('zono_developer_console_unlock', { p_pin: pin });
            if (error) throw error;
            if (!data?.token) throw new Error('تعذر إنشاء جلسة الحماية');
            this.developerQueryToken = data.token;
            this.developerQueryTokenExpiresAt = data.expires_at || null;
            if (pinEl) pinEl.value = '';
            if (confirmEl) confirmEl.value = '';
            document.getElementById('developer-query-lock-view')?.classList.add('hidden');
            document.getElementById('developer-query-console-view')?.classList.remove('hidden');
            await this.loadDeveloperUsers();
        } catch (e) {
            const raw = String(e?.message || '');
            const friendly = raw.includes('INVALID_PIN') ? 'رمز الحماية غير صحيح'
                : raw.includes('CONSOLE_LOCKED') ? 'تم قفل المحاولات مؤقتاً. حاول لاحقاً'
                : raw.includes('PIN_ALREADY_CONFIGURED') ? 'رمز الحماية مُعد مسبقاً'
                : raw.includes('DEVELOPER_ONLY') ? 'هذه المنطقة للمطور فقط'
                : raw || 'تعذر فتح القفل';
            if (status) status.textContent = friendly;
            if (raw.includes('CONSOLE_LOCKED')) await this.prepareDeveloperQueryLock();
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    debounceDeveloperUserSearch() {
        clearTimeout(this._developerUserSearchTimer);
        this._developerUserSearchTimer = setTimeout(() => this.loadDeveloperUsers(), 260);
    }

    async loadDeveloperUsers() {
        if (!this.developerQueryToken) return this.prepareDeveloperQueryLock();
        const list = document.getElementById('developer-query-users');
        const detail = document.getElementById('developer-query-detail');
        const q = String(document.getElementById('developer-query-search')?.value || '').trim();
        if (detail) detail.classList.add('hidden');
        if (list) {
            list.classList.remove('hidden');
            list.innerHTML = '<div class="zono-developer-query-empty">جاري تحميل الحسابات...</div>';
        }
        try {
            const client = window.zonoBackend?.client || window.zonoAuth?.client;
            const { data, error } = await client.rpc('zono_developer_query_users', {
                p_token: this.developerQueryToken,
                p_query: q || null
            });
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            if (!list) return;
            if (!rows.length) {
                list.innerHTML = '<div class="zono-developer-query-empty">لا توجد حسابات مطابقة</div>';
                return;
            }
            list.innerHTML = rows.map(row => `
                <button class="zono-developer-user-row" onclick="window.zonoApp.openDeveloperUserDetail(${Number(row.public_id || 0)})">
                    <div class="zono-developer-user-avatar">${this.escapeHtml(String(row.display_name || row.username || 'Z').slice(0,1).toUpperCase())}</div>
                    <div class="zono-developer-user-copy">
                        <strong>${this.escapeHtml(row.display_name || row.username || 'مستخدم ZONO')}</strong>
                        <small>ID ${Number(row.public_id || 0).toLocaleString('en-US')}</small>
                    </div>
                    <span class="zono-developer-user-level">LV.${Number(row.account_level || 1).toLocaleString('en-US')}</span>
                </button>
            `).join('');
        } catch (e) {
            const raw = String(e?.message || '');
            if (raw.includes('INVALID_CONSOLE_SESSION') || raw.includes('CONSOLE_SESSION_EXPIRED')) {
                this.developerQueryToken = null;
                return this.prepareDeveloperQueryLock();
            }
            if (list) list.innerHTML = `<div class="zono-developer-query-empty text-red-300">${this.escapeHtml(raw || 'تعذر تحميل الحسابات')}</div>`;
        }
    }

    async openDeveloperUserDetail(publicId) {
        if (!this.developerQueryToken) return;
        const list = document.getElementById('developer-query-users');
        const detail = document.getElementById('developer-query-detail');
        if (list) list.classList.add('hidden');
        if (detail) {
            detail.classList.remove('hidden');
            detail.classList.add('zono-loading');
        }
        try {
            const client = window.zonoBackend?.client || window.zonoAuth?.client;
            const { data, error } = await client.rpc('zono_developer_user_details', {
                p_token: this.developerQueryToken,
                p_public_id: Number(publicId)
            });
            if (error) throw error;
            this.developerQuerySelectedId = Number(data.public_id || publicId);
            const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
            setText('developer-query-detail-name', data.display_name || data.username || 'مستخدم ZONO');
            setText('developer-query-detail-id', `ID ${Number(data.public_id || 0).toLocaleString('en-US')}`);
            setText('developer-query-detail-level', Number(data.account_level || 1).toLocaleString('en-US'));
            setText('developer-query-detail-seeds', Number(data.seeds || 0).toLocaleString('en-US'));
            setText('developer-query-detail-feathers', Number(data.feathers || 0).toLocaleString('en-US'));
            setText('developer-query-detail-daily', Number(data.daily_seeds || 0).toLocaleString('en-US'));
            setText('developer-query-detail-counter', data.has_counter ? 'نعم ✓' : 'لا');
            const counterEl = document.getElementById('developer-query-detail-counter');
            if (counterEl) counterEl.className = data.has_counter ? 'zono-counter-yes' : 'zono-counter-no';
            const plan = document.getElementById('developer-query-detail-plan');
            if (plan) {
                plan.textContent = data.has_counter
                    ? `العداد الحالي: ${data.active_bird || 'مفعّل'}${data.bird_plan_ends_at ? ` • ينتهي ${new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium'}).format(new Date(data.bird_plan_ends_at))}` : ''}`
                    : 'لا يوجد عداد مدفوع فعّال على الحساب';
            }
        } catch (e) {
            this.showToast(e.message || 'تعذر جلب كشف الحساب', 'error');
            this.closeDeveloperUserDetail();
        } finally {
            detail?.classList.remove('zono-loading');
        }
    }

    closeDeveloperUserDetail() {
        document.getElementById('developer-query-detail')?.classList.add('hidden');
        document.getElementById('developer-query-users')?.classList.remove('hidden');
        this.developerQuerySelectedId = null;
    }

    async zeroDeveloperUserSeeds() {
        const publicId = Number(this.developerQuerySelectedId || 0);
        if (!publicId || !this.developerQueryToken) return;
        if (!window.confirm(`تأكيد تصفير بذور الحساب ID ${publicId}؟\nهذه العملية ستجعل الرصيد 0 فوراً.`)) return;
        const btn = document.getElementById('developer-query-zero-seeds');
        try {
            if (btn) btn.disabled = true;
            const client = window.zonoBackend?.client || window.zonoAuth?.client;
            const { data, error } = await client.rpc('zono_developer_zero_user_seeds', {
                p_token: this.developerQueryToken,
                p_public_id: publicId
            });
            if (error) throw error;
            const seedsEl = document.getElementById('developer-query-detail-seeds');
            if (seedsEl) seedsEl.textContent = '0';
            this.showToast(`تم تصفير ${Number(data?.previous_seeds || 0).toLocaleString('en-US')} بذرة من ID ${publicId}`, 'success');
        } catch (e) {
            this.showToast(e.message || 'تعذر تصفير البذور', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async closeDeveloperQueryModal() {
        const modal = document.getElementById('developer-query-modal');
        modal?.classList.add('hidden');
        modal?.classList.remove('flex');
        const token = this.developerQueryToken;
        this.developerQueryToken = null;
        this.developerQuerySelectedId = null;
        clearTimeout(this._developerUserSearchTimer);
        if (token) {
            try {
                const client = window.zonoBackend?.client || window.zonoAuth?.client;
                await client?.rpc('zono_developer_console_lock_session', { p_token: token });
            } catch (_) {}
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

        window.addEventListener('popstate',()=>{
            if(this.activeRoom){
                this._roomHistoryArmed=false;
                this.requestRoomExit(true);
            }
        });

        const roomShell=document.getElementById('zono-room-shell');
        if(roomShell){
            let startX=null,startY=null;
            roomShell.addEventListener('touchstart',(e)=>{
                const t=e.touches?.[0];
                if(t && t.clientX<28){startX=t.clientX;startY=t.clientY}
                else {startX=null;startY=null}
            },{passive:true});
            roomShell.addEventListener('touchend',(e)=>{
                if(startX===null) return;
                const t=e.changedTouches?.[0];
                const dx=(t?.clientX||0)-startX;
                const dy=Math.abs((t?.clientY||0)-(startY||0));
                startX=null;startY=null;
                if(dx>75 && dy<90) this.requestRoomExit(false);
            },{passive:true});
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
