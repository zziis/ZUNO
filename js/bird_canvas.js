// Zono App - 24-Hour Flying Bird & Perched Branch Engine
class ZonoBirdEngine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        
        // Dimensions
        this.width = this.canvas.width = 440;
        this.height = this.canvas.height = 440;
        this.centerX = this.width / 2;
        this.centerY = this.height / 2;
        this.radius = 180;

        // State
        this.isFlying = false;
        this.skin = 'classic_gold'; // classic_gold, emerald, royal_blue, crimson_phoenix
        this.flightDuration = window.zonoApp?.currentUser?.role === 'developer' ? 3 * 60 * 1000 : 24 * 60 * 60 * 1000; // developer 3 min, others 24h
        this.flightEndTime = null;
        this.flightStartTime = null;
        this.remainingMs = this.flightDuration;
        
        // Animation variables
        this.tick = 0;
        this.wingAngle = 0;
        this.wingSpeed = 0.2;
        this.birdPos = { x: this.centerX, y: this.centerY + 40, angle: 0 };
        this.targetPos = { x: this.centerX, y: this.centerY + 40 };
        this.particles = [];
        this.leaves = [];
        
        // Perched state animation
        this.breatheOffset = 0;
        this.tailWiggle = 0;
        this.blinkTimer = 0;
        this.isBlinking = false;
        this.headTurn = 0;

        // Orbit path for flying state
        this.orbitAngle = 0;
        this.orbitRadiusX = 110;
        this.orbitRadiusY = 70;

        this.initLeaves();
        this.loadState();
        this.bindEvents();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    initLeaves() {
        this.leaves = [
            { x: this.centerX - 70, y: this.centerY + 75, size: 14, angle: -0.4, color: '#38A169' },
            { x: this.centerX - 100, y: this.centerY + 95, size: 18, angle: -0.8, color: '#2F855A' },
            { x: this.centerX - 40, y: this.centerY + 85, size: 12, angle: 0.3, color: '#48BB78' },
            { x: this.centerX - 125, y: this.centerY + 115, size: 16, angle: -0.6, color: '#276749' }
        ];
    }

    loadState() {
        const savedEndTime = localStorage.getItem('zono_flight_end_time');
        const savedStartTime = localStorage.getItem('zono_flight_start_time');
        const savedSkin = localStorage.getItem('zono_bird_skin');

        if (savedSkin) this.skin = savedSkin;

        if (savedEndTime && savedStartTime) {
            const now = Date.now();
            const end = parseInt(savedEndTime, 10);
            if (end > now) {
                this.isFlying = true;
                this.flightStartTime = parseInt(savedStartTime, 10);
                this.flightEndTime = end;
                this.remainingMs = end - now;
            } else {
                this.resetFlight(false);
            }
        }
        this.updateUI();
    }

    saveState() {
        if (this.isFlying && this.flightEndTime) {
            localStorage.setItem('zono_flight_end_time', this.flightEndTime.toString());
            localStorage.setItem('zono_flight_start_time', this.flightStartTime.toString());
        } else {
            localStorage.removeItem('zono_flight_end_time');
            localStorage.removeItem('zono_flight_start_time');
        }
        localStorage.setItem('zono_bird_skin', this.skin);
    }

    setSkin(skinName) {
        this.skin = skinName;
        this.saveState();
    }

    toggleFlight() {
        if (this.isFlying) {
            // Optional: User can pause or land early
            const confirmLand = confirm("هل ترغب في إعادة العصفور إلى الغصن ليرتاح؟");
            if (confirmLand) {
                this.resetFlight(true);
            }
        } else {
            this.startFlight();
        }
    }

    startFlight() {
        const now = Date.now();
        this.isFlying = true;
        this.flightStartTime = now;
        this.flightEndTime = now + this.flightDuration;
        this.remainingMs = this.flightDuration;
        this.saveState();

        if (window.zonoAudio) {
            window.zonoAudio.playChirp();
        }

        // Spawn takeoff feather particles
        for (let i = 0; i < 20; i++) {
            this.spawnParticle(this.birdPos.x, this.birdPos.y, true);
        }

        this.updateUI();
        if (window.showZonoToast) {
            window.showZonoToast("انطلق عصفور زونو في رحلة الـ 24 ساعة بنجاح! 🕊️✨", "success");
        }
    }

    resetFlight(landedEarly = false) {
        this.isFlying = false;
        this.flightEndTime = null;
        this.flightStartTime = null;
        this.remainingMs = this.flightDuration;
        this.saveState();
        this.updateUI();
        if (window.showZonoToast && landedEarly) {
            window.showZonoToast("عاد العصفور ليستقر على غصنه الدافئ.", "info");
        }
    }

    spawnParticle(x, y, isFeather = false) {
        const colors = this.getSkinColors();
        this.particles.push({
            x: x + (Math.random() - 0.5) * 16,
            y: y + (Math.random() - 0.5) * 16,
            vx: (Math.random() - 0.5) * 2.5,
            vy: (Math.random() - 0.5) * 2.5 - (isFeather ? 1.5 : 0),
            size: isFeather ? (Math.random() * 5 + 4) : (Math.random() * 3 + 1.5),
            color: isFeather ? colors.primary : (Math.random() > 0.5 ? '#D4AF37' : '#F6E05E'),
            alpha: 1,
            decay: isFeather ? 0.015 : 0.025,
            rot: Math.random() * Math.PI * 2,
            vRot: (Math.random() - 0.5) * 0.1,
            isFeather: isFeather
        });
    }

    bindEvents() {
        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) * (this.width / rect.width);
            const y = (e.clientY - rect.top) * (this.height / rect.height);

            const dx = x - this.centerX;
            const dy = y - this.centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Click within the circular dial
            if (dist <= this.radius + 15) {
                if (!this.isFlying) {
                    this.startFlight();
                } else {
                    // Tap flying bird to make it chirp & flourish
                    if (window.zonoAudio) window.zonoAudio.playChirp();
                    for (let i = 0; i < 10; i++) {
                        this.spawnParticle(this.birdPos.x, this.birdPos.y, false);
                    }
                }
            }
        });
    }

    getSkinColors() {
        switch (this.skin) {
            case 'emerald':
                return { primary: '#10B981', secondary: '#047857', belly: '#A7F3D0', beak: '#F59E0B', glow: 'rgba(16, 185, 129, 0.4)' };
            case 'royal_blue':
                return { primary: '#3B82F6', secondary: '#1D4ED8', belly: '#BFDBFE', beak: '#F97316', glow: 'rgba(59, 130, 246, 0.4)' };
            case 'crimson_phoenix':
                return { primary: '#EF4444', secondary: '#B91C1C', belly: '#FDE047', beak: '#FBBF24', glow: 'rgba(239, 68, 68, 0.45)' };
            case 'classic_gold':
            default:
                return { primary: '#D4AF37', secondary: '#B7791F', belly: '#FEFCBF', beak: '#DD6B20', glow: 'rgba(212, 175, 55, 0.4)' };
        }
    }

    updateTimer() {
        if (this.isFlying && this.flightEndTime) {
            const now = Date.now();
            this.remainingMs = Math.max(0, this.flightEndTime - now);

            if (this.remainingMs <= 0) {
                this.resetFlight(false);
                if (window.showZonoToast) {
                    if (window.zonoApp?.currentUser?.role === 'developer') {
                        window.zunoBackend.client.rpc('zono_developer_claim_seeds').then(async ({data,error}) => {
                            if (error) return window.showZonoToast(error.message || 'تعذر إضافة البذور','error');
                            await window.zonoAuth.loadProfile(window.zonoAuth.user);
                            await window.zonoApp.syncUserFromSupabase();
                            window.showZonoToast(`اكتملت 3 دقائق: +${Number(data?.reward||0).toLocaleString('en-US')} بذرة 🌾`,'success');
                        });
                    } else {
                        window.showZonoToast("مبروك! اكتملت رحلة الـ 24 ساعة 🏆", "success");
                    }
                }
            }
        }
        this.updateUI();
    }

    formatTime(ms) {
        const totalSecs = Math.floor(ms / 1000);
        const hours = Math.floor(totalSecs / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;
        return {
            formatted: `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
            hours, mins, secs
        };
    }

    updateUI() {
        const timerEl = document.getElementById('bird-timer-display');
        const statusEl = document.getElementById('bird-status-badge');
        const triggerBtn = document.getElementById('bird-trigger-btn');
        const progressCircle = document.getElementById('bird-svg-progress');
        const quoteEl = document.getElementById('bird-quote-text');

        const time = this.formatTime(this.remainingMs);

        if (timerEl) {
            timerEl.textContent = time.formatted;
        }

        if (statusEl) {
            if (this.isFlying) {
                statusEl.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse ml-1.5"></span> العصفور طائر في الأجواء (نشط)`;
                statusEl.className = "px-4 py-1.5 rounded-full text-xs font-bold bg-emerald-950/70 text-emerald-300 border border-emerald-500/40 backdrop-blur-md shadow-lg shadow-emerald-900/30 flex items-center";
            } else {
                statusEl.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 ml-1.5"></span> مستقر على الغصن (جاهز للطيران)`;
                statusEl.className = "px-4 py-1.5 rounded-full text-xs font-bold bg-amber-950/70 text-amber-300 border border-amber-500/40 backdrop-blur-md shadow-lg shadow-amber-900/30 flex items-center";
            }
        }

        if (triggerBtn) {
            if (this.isFlying) {
                triggerBtn.innerHTML = `
                    <svg class="w-5 h-5 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <span>إيقاف مؤقت / عودة للغصن</span>
                `;
                triggerBtn.className = "w-full py-3.5 px-6 rounded-2xl font-bold bg-gradient-to-r from-red-900/80 to-amber-900/80 hover:from-red-800 hover:to-amber-800 text-amber-100 border border-amber-500/30 shadow-lg flex items-center justify-center transition-all duration-300 active:scale-95";
            } else {
                triggerBtn.innerHTML = `
                    <svg class="w-5 h-5 ml-2 text-amber-300 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                    <span>إطلاق العصفور للتحليق (24 ساعة)</span>
                `;
                triggerBtn.className = "w-full py-3.5 px-6 rounded-2xl font-bold bg-gradient-to-r from-amber-600 via-yellow-600 to-amber-700 hover:from-amber-500 hover:to-yellow-500 text-stone-950 border border-yellow-300/60 shadow-xl shadow-amber-600/30 flex items-center justify-center transition-all duration-300 active:scale-95 text-base";
            }
        }

        if (progressCircle) {
            const circumference = 2 * Math.PI * 140;
            const progress = (this.flightDuration - this.remainingMs) / this.flightDuration;
            const offset = circumference - (progress * circumference);
            progressCircle.style.strokeDasharray = `${circumference}`;
            progressCircle.style.strokeDashoffset = `${offset}`;
        }

        if (quoteEl && this.isFlying) {
            const quotes = [
                "«الطيور لا تلتفت إلى الوراء وهي تصنع مجدها في السماء»",
                "«كل ساعة طيران تقربك من أوسمة زونو النادرة»",
                "«عصفورك يحلق بثبات، استمتع بيومك وحقق أهدافك»",
                "«النوستالجيا والكلاسيكية في أبهى صورها مع زونو»"
            ];
            const qIndex = Math.floor((Date.now() / 30000) % quotes.length);
            quoteEl.textContent = quotes[qIndex];
        }
    }

    drawDial() {
        const ctx = this.ctx;

        // Background Disc
        ctx.save();
        const bgGradient = ctx.createRadialGradient(this.centerX, this.centerY, 40, this.centerX, this.centerY, this.radius);
        bgGradient.addColorStop(0, '#16222F');
        bgGradient.addColorStop(0.7, '#0C131A');
        bgGradient.addColorStop(1, '#080C10');

        ctx.fillStyle = bgGradient;
        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, this.radius, 0, Math.PI * 2);
        ctx.fill();

        // Inner Ambient Glow
        const colors = this.getSkinColors();
        const innerGlow = ctx.createRadialGradient(this.centerX, this.centerY, 10, this.centerX, this.centerY, this.radius - 20);
        innerGlow.addColorStop(0, this.isFlying ? colors.glow : 'rgba(212, 175, 55, 0.08)');
        innerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = innerGlow;
        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, this.radius - 10, 0, Math.PI * 2);
        ctx.fill();

        // Outer Brass Frame Rings
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#D4AF37';
        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, this.radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(246, 224, 94, 0.4)';
        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, this.radius - 8, 0, Math.PI * 2);
        ctx.stroke();

        // Classic Hour Marks & Roman/24h Graduations
        for (let i = 0; i < 24; i++) {
            const angle = (i / 24) * Math.PI * 2 - Math.PI / 2;
            const isMajor = i % 3 === 0;
            const innerR = isMajor ? this.radius - 22 : this.radius - 14;
            const outerR = this.radius - 10;

            const x1 = this.centerX + Math.cos(angle) * innerR;
            const y1 = this.centerY + Math.sin(angle) * innerR;
            const x2 = this.centerX + Math.cos(angle) * outerR;
            const y2 = this.centerY + Math.sin(angle) * outerR;

            ctx.lineWidth = isMajor ? 2.5 : 1;
            ctx.strokeStyle = isMajor ? '#ECC94B' : 'rgba(212, 175, 55, 0.4)';
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            // Hour numbers on quarters
            if (isMajor) {
                const textR = this.radius - 34;
                const tx = this.centerX + Math.cos(angle) * textR;
                const ty = this.centerY + Math.sin(angle) * textR;

                ctx.font = 'bold 10px "Cairo", serif';
                ctx.fillStyle = '#D69E2E';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const label = i === 0 ? '24' : String(i);
                ctx.fillText(label, tx, ty);
            }
        }

        ctx.restore();
    }

    drawBranch() {
        const ctx = this.ctx;
        ctx.save();

        // Branch fades or lowers slightly when flying
        ctx.globalAlpha = this.isFlying ? 0.35 : 1.0;

        // Realistic curved woody branch
        const startX = this.centerX - 170;
        const startY = this.centerY + 140;
        const cp1X = this.centerX - 60;
        const cp1Y = this.centerY + 85;
        const cp2X = this.centerX + 20;
        const cp2Y = this.centerY + 95;
        const endX = this.centerX + 130;
        const endY = this.centerY + 110;

        // Branch Shadow
        ctx.lineWidth = 14;
        ctx.strokeStyle = 'rgba(15, 10, 5, 0.6)';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(startX, startY + 4);
        ctx.bezierCurveTo(cp1X, cp1Y + 4, cp2X, cp2Y + 4, endX, endY + 4);
        ctx.stroke();

        // Branch Main Wood
        ctx.lineWidth = 12;
        ctx.strokeStyle = '#5D4037';
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
        ctx.stroke();

        // Branch Highlight
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#8D6E63';
        ctx.beginPath();
        ctx.moveTo(startX + 20, startY - 2);
        ctx.bezierCurveTo(cp1X, cp1Y - 2, cp2X - 20, cp2Y - 2, endX - 30, endY - 2);
        ctx.stroke();

        // Leaves
        this.leaves.forEach((leaf) => {
            ctx.save();
            ctx.translate(leaf.x, leaf.y);
            const sway = Math.sin(this.tick * 0.05 + leaf.x) * 0.1;
            ctx.rotate(leaf.angle + sway);

            ctx.fillStyle = leaf.color;
            ctx.beginPath();
            ctx.ellipse(0, 0, leaf.size, leaf.size * 0.5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Leaf vein
            ctx.strokeStyle = '#22543D';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-leaf.size, 0);
            ctx.lineTo(leaf.size, 0);
            ctx.stroke();

            ctx.restore();
        });

        // Small blossom buds
        ctx.fillStyle = '#FED7D7';
        ctx.beginPath();
        ctx.arc(this.centerX - 110, this.centerY + 95, 4.5, 0, Math.PI * 2);
        ctx.arc(this.centerX - 30, this.centerY + 88, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    drawPerchedBird(x, y) {
        const ctx = this.ctx;
        const colors = this.getSkinColors();
        ctx.save();

        this.breatheOffset = Math.sin(this.tick * 0.06) * 1.5;
        this.tailWiggle = Math.sin(this.tick * 0.09) * 0.08;

        ctx.translate(x, y + this.breatheOffset);

        // Subtle shadow on branch
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.beginPath();
        ctx.ellipse(0, 16, 22, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Tail
        ctx.save();
        ctx.translate(-22, 5);
        ctx.rotate(-0.35 + this.tailWiggle);
        ctx.fillStyle = colors.secondary;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-30, -5);
        ctx.lineTo(-34, 12);
        ctx.lineTo(0, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Bird Claws on branch
        ctx.strokeStyle = '#ED8936';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        // Front claw
        ctx.moveTo(-5, 10); ctx.lineTo(-7, 16); ctx.lineTo(-12, 17);
        ctx.moveTo(7, 10); ctx.lineTo(5, 16); ctx.lineTo(0, 17);
        ctx.stroke();

        // Bird Body / Torso
        ctx.fillStyle = colors.primary;
        ctx.beginPath();
        ctx.ellipse(0, 0, 24, 19, -0.15, 0, Math.PI * 2);
        ctx.fill();

        // Bird Belly
        ctx.fillStyle = colors.belly;
        ctx.beginPath();
        ctx.ellipse(6, 4, 14, 12, 0.2, 0, Math.PI * 2);
        ctx.fill();

        // Folded Wing
        ctx.fillStyle = colors.secondary;
        ctx.beginPath();
        ctx.ellipse(-6, -2, 17, 10, -0.3, 0, Math.PI * 2);
        ctx.fill();

        // Wing feather accents
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(-5, -2, 11, 0.4, 2.2);
        ctx.stroke();

        // Bird Head
        ctx.fillStyle = colors.primary;
        ctx.beginPath();
        ctx.arc(18, -12, 13, 0, Math.PI * 2);
        ctx.fill();

        // Bird Beak
        ctx.fillStyle = colors.beak;
        ctx.beginPath();
        ctx.moveTo(29, -15);
        ctx.lineTo(39, -11);
        ctx.lineTo(29, -7);
        ctx.closePath();
        ctx.fill();

        // Bird Eye with blinking
        this.blinkTimer++;
        if (this.blinkTimer > 180) {
            this.isBlinking = true;
            if (this.blinkTimer > 192) {
                this.isBlinking = false;
                this.blinkTimer = 0;
            }
        }

        if (this.isBlinking) {
            ctx.strokeStyle = '#1A202C';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(19, -13);
            ctx.lineTo(25, -13);
            ctx.stroke();
        } else {
            // White eye ring
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(22, -13, 3.8, 0, Math.PI * 2);
            ctx.fill();
            // Black pupil
            ctx.fillStyle = '#1A202C';
            ctx.beginPath();
            ctx.arc(23, -13, 2.2, 0, Math.PI * 2);
            ctx.fill();
            // Eye gleam
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            ctx.arc(24, -14, 0.9, 0, Math.PI * 2);
            ctx.fill();
        }

        // Royal Crest / Feather tuft
        ctx.strokeStyle = colors.secondary;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(14, -24);
        ctx.quadraticCurveTo(8, -32, 4, -28);
        ctx.stroke();

        ctx.restore();
    }

    drawFlyingBird(x, y, angle) {
        const ctx = this.ctx;
        const colors = this.getSkinColors();
        ctx.save();

        ctx.translate(x, y);
        ctx.rotate(angle);

        // Flapping motion using sine wave
        const flap = Math.sin(this.wingAngle);
        const wingYOffset = flap * 24;

        // Aura / Glow
        ctx.shadowColor = colors.primary;
        ctx.shadowBlur = 18;

        // Tail feathers (spread in flight)
        ctx.fillStyle = colors.secondary;
        ctx.beginPath();
        ctx.moveTo(-18, 0);
        ctx.lineTo(-38, -12);
        ctx.lineTo(-44, 0);
        ctx.lineTo(-38, 12);
        ctx.closePath();
        ctx.fill();

        // Torso
        ctx.fillStyle = colors.primary;
        ctx.beginPath();
        ctx.ellipse(0, 0, 22, 12, 0, 0, Math.PI * 2);
        ctx.fill();

        // Belly
        ctx.fillStyle = colors.belly;
        ctx.beginPath();
        ctx.ellipse(4, 2, 13, 7, 0, 0, Math.PI * 2);
        ctx.fill();

        // Upper Wing (animated flapping)
        ctx.save();
        ctx.fillStyle = colors.secondary;
        ctx.beginPath();
        ctx.moveTo(-4, -4);
        ctx.quadraticCurveTo(-10, -32 - wingYOffset, -2, -38 - wingYOffset);
        ctx.quadraticCurveTo(18, -30 - wingYOffset * 0.6, 12, -4);
        ctx.closePath();
        ctx.fill();

        // Feather highlights on wing
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-4, -14 - wingYOffset * 0.4);
        ctx.lineTo(6, -26 - wingYOffset * 0.8);
        ctx.stroke();
        ctx.restore();

        // Lower Wing (perspective)
        ctx.save();
        ctx.fillStyle = colors.primary;
        ctx.beginPath();
        ctx.moveTo(-4, 4);
        ctx.quadraticCurveTo(-8, 26 + wingYOffset * 0.8, 0, 32 + wingYOffset * 0.8);
        ctx.quadraticCurveTo(16, 24 + wingYOffset * 0.4, 10, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Head
        ctx.fillStyle = colors.primary;
        ctx.beginPath();
        ctx.arc(20, -2, 10, 0, Math.PI * 2);
        ctx.fill();

        // Beak
        ctx.fillStyle = colors.beak;
        ctx.beginPath();
        ctx.moveTo(28, -5);
        ctx.lineTo(38, -2);
        ctx.lineTo(28, 1);
        ctx.closePath();
        ctx.fill();

        // Eye
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(23, -3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1A202C';
        ctx.beginPath();
        ctx.arc(24, -3, 1.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    drawParticles() {
        const ctx = this.ctx;
        ctx.save();

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.alpha -= p.decay;
            p.rot += p.vRot;

            if (p.alpha <= 0) {
                this.particles.splice(i, 1);
                continue;
            }

            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);

            if (p.isFeather) {
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.ellipse(0, 0, p.size, p.size * 0.4, 0, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(0, 0, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        ctx.restore();
    }

    animate() {
        this.tick++;
        this.ctx.clearRect(0, 0, this.width, this.height);

        // Draw Clock Background Dial & Roman marks
        this.drawDial();

        // Draw Branch
        this.drawBranch();

        if (this.isFlying) {
            this.wingAngle += this.wingSpeed;
            // Majestic Lissajous / Infinity orbital path
            this.orbitAngle += 0.022;
            const flightX = this.centerX + Math.cos(this.orbitAngle) * this.orbitRadiusX;
            const flightY = this.centerY + Math.sin(this.orbitAngle * 2) * (this.orbitRadiusY * 0.6) - 15;

            // Calculate flight direction angle for smooth banking
            const nextAngle = this.orbitAngle + 0.02;
            const nextX = this.centerX + Math.cos(nextAngle) * this.orbitRadiusX;
            const nextY = this.centerY + Math.sin(nextAngle * 2) * (this.orbitRadiusY * 0.6) - 15;
            const dirAngle = Math.atan2(nextY - flightY, nextX - flightX);

            this.birdPos.x += (flightX - this.birdPos.x) * 0.15;
            this.birdPos.y += (flightY - this.birdPos.y) * 0.15;
            this.birdPos.angle = dirAngle;

            // Spawn fairy golden dust particles
            if (this.tick % 4 === 0) {
                this.spawnParticle(this.birdPos.x - Math.cos(dirAngle) * 20, this.birdPos.y - Math.sin(dirAngle) * 20, false);
            }

            this.drawFlyingBird(this.birdPos.x, this.birdPos.y, this.birdPos.angle);
        } else {
            // Smoothly ease bird back to perched branch
            const perchedTarget = { x: this.centerX - 10, y: this.centerY + 50 };
            this.birdPos.x += (perchedTarget.x - this.birdPos.x) * 0.08;
            this.birdPos.y += (perchedTarget.y - this.birdPos.y) * 0.08;

            this.drawPerchedBird(this.birdPos.x, this.birdPos.y);
        }

        // Draw active floating particles & sparkles
        this.drawParticles();

        // Periodic UI clock update
        if (this.tick % 15 === 0) {
            this.updateTimer();
        }

        requestAnimationFrame(this.animate);
    }
}

window.ZonoBirdEngine = ZonoBirdEngine;
