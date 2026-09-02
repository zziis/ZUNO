/*
 * ZONO Live Voice Engine
 * Free P2P WebRTC audio + Supabase Realtime Broadcast/Presence for signalling.
 * No paid audio service required.
 *
 * Notes:
 * - Uses public STUN only. No TURN server is configured.
 * - Suitable for light/early usage. Some restrictive mobile/carrier networks may need TURN later.
 */
(() => {
    class ZonoLiveVoiceEngine {
        constructor() {
            this.roomId = null;
            this.channel = null;
            this.peerId = this.makePeerId();

            this.localStream = null;
            this.isPublishing = false;
            this.isMuted = false;

            // remote speaker -> RTCPeerConnection (we receive audio)
            this.receiverPeers = new Map();
            // remote listener -> RTCPeerConnection (we publish our mic)
            this.publisherPeers = new Map();
            this.remoteAudios = new Map();

            this.iceServers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ];

            this._joining = null;
            this._lastPresenceOnMic = null;
        }

        get app() {
            return window.zonoApp || null;
        }

        get client() {
            return window.zunoBackend?.client || window.zunoAuth?.client || null;
        }

        makePeerId() {
            if (crypto?.randomUUID) return crypto.randomUUID();
            return `peer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }

        myPublicId() {
            return Number(this.app?.currentUser?.publicId || 0);
        }

        myName() {
            return String(this.app?.currentUser?.displayName || 'Zono');
        }

        isMySeatActive() {
            const state = this.app?.roomMicState;
            const myId = this.myPublicId();
            if (!state?.active || !myId) return false;
            return Array.isArray(state.seats) &&
                state.seats.some(s => Number(s.user_public_id) === myId);
        }

        isRemoteAuthorizedSpeaker(publicId) {
            const state = this.app?.roomMicState;
            if (!state?.active) return false;
            return Array.isArray(state.seats) &&
                state.seats.some(s => Number(s.user_public_id) === Number(publicId));
        }

        setStatus(state, text) {
            this.app?.updateLiveAudioStatus?.(state, text);
        }

        async joinRoom(roomId) {
            roomId = Number(roomId);
            if (!roomId || !this.client) return;

            if (this.roomId === roomId && this.channel) {
                return;
            }

            if (this._joining) {
                try { await this._joining; } catch (_) {}
            }

            this._joining = this._joinRoom(roomId);
            try {
                await this._joining;
            } finally {
                this._joining = null;
            }
        }

        async _joinRoom(roomId) {
            await this.leaveRoom();

            this.roomId = roomId;
            this.peerId = this.makePeerId();
            this.setStatus('connecting', 'جاري ربط الصوت');

            const topic = `zono-voice-${roomId}`;
            const ch = this.client.channel(topic, {
                config: {
                    broadcast: { self: false, ack: false },
                    presence: { key: this.peerId }
                }
            });

            this.channel = ch;

            ch.on('broadcast', { event: 'voice-signal' }, ({ payload }) => {
                this.handleSignal(payload).catch(() => {});
            });

            ch.on('broadcast', { event: 'voice-state' }, ({ payload }) => {
                this.handleVoiceState(payload).catch(() => {});
            });

            ch.on('presence', { event: 'sync' }, () => {
                this.handlePresenceSync().catch(() => {});
            });

            ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
                (leftPresences || []).forEach(p => {
                    const peer = p.peer_id || p.peerId;
                    if (peer) this.closePeer(peer);
                });
            });

            await new Promise((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        reject(new Error('Realtime timeout'));
                    }
                }, 9000);

                ch.subscribe(async (status, err) => {
                    if (settled) return;
                    if (status === 'SUBSCRIBED') {
                        settled = true;
                        clearTimeout(timer);
                        try {
                            await this.updatePresence();
                        } catch (_) {}
                        resolve();
                    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        settled = true;
                        clearTimeout(timer);
                        reject(err || new Error(status));
                    }
                });
            }).catch((e) => {
                this.setStatus('error', 'فشل الربط');
                throw e;
            });

            this.setStatus('on', 'الصوت متصل');
            await this.syncMicState();
            await this.handlePresenceSync();
        }

        async updatePresence(force = false) {
            if (!this.channel) return;
            const onMic = this.isMySeatActive();
            if (!force && this._lastPresenceOnMic === onMic) return;
            this._lastPresenceOnMic = onMic;

            await this.channel.track({
                peer_id: this.peerId,
                user_public_id: this.myPublicId(),
                display_name: this.myName(),
                on_mic: onMic,
                updated_at: new Date().toISOString()
            });

            await this.sendBroadcast('voice-state', {
                peer_id: this.peerId,
                user_public_id: this.myPublicId(),
                on_mic: onMic
            });
        }

        async sendBroadcast(event, payload) {
            if (!this.channel) return;
            try {
                await this.channel.send({
                    type: 'broadcast',
                    event,
                    payload
                });
            } catch (_) {}
        }

        async syncMicState() {
            if (!this.channel || !this.roomId) return;

            const shouldPublish = this.isMySeatActive();
            if (shouldPublish && !this.isPublishing) {
                await this.startPublishing();
            } else if (!shouldPublish && this.isPublishing) {
                await this.stopPublishing();
            }

            await this.updatePresence();
            await this.handlePresenceSync();

            // Drop receivers whose users are no longer seated.
            for (const [peerId, meta] of this.receiverPeers.entries()) {
                const publicId = meta._zonoPublicId;
                if (publicId && !this.isRemoteAuthorizedSpeaker(publicId)) {
                    this.closeReceiver(peerId);
                }
            }
        }

        async startPublishing() {
            if (this.isPublishing) return;

            if (!navigator.mediaDevices?.getUserMedia) {
                this.setStatus('error', 'الميكروفون غير مدعوم');
                this.app?.showToast?.('هذا الجهاز لا يدعم الوصول للميكروفون', 'error');
                return;
            }

            try {
                this.setStatus('connecting', 'تشغيل المايك');
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1
                    },
                    video: false
                });

                this.localStream = stream;
                this.isPublishing = true;
                this.isMuted = false;

                for (const track of stream.getAudioTracks()) {
                    track.enabled = true;
                    track.onended = () => {
                        this.stopPublishing().catch(() => {});
                    };
                }

                this.setStatus('on', 'مايك مباشر');
                await this.updatePresence(true);

                // Existing listeners will discover us through presence/voice-state.
            } catch (e) {
                this.isPublishing = false;
                this.localStream = null;
                this.setStatus('error', 'اسمح بالميكروفون');
                this.app?.showToast?.(
                    'اسمح للتطبيق باستخدام الميكروفون حتى يعمل المايك المباشر',
                    'error'
                );
            }
        }

        async stopPublishing() {
            this.isPublishing = false;

            if (this.localStream) {
                this.localStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (_) {}
                });
            }
            this.localStream = null;
            this.isMuted = false;

            for (const peerId of [...this.publisherPeers.keys()]) {
                this.closePublisher(peerId);
            }

            await this.updatePresence(true);
            if (this.roomId) this.setStatus('on', 'الصوت متصل');
        }

        toggleMute() {
            if (!this.localStream) return true;
            this.isMuted = !this.isMuted;
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = !this.isMuted;
            });
            return this.isMuted;
        }

        newPeerConnection(remotePeerId, mode) {
            const pc = new RTCPeerConnection({ iceServers: this.iceServers });

            pc.onicecandidate = (event) => {
                if (!event.candidate) return;
                this.sendBroadcast('voice-signal', {
                    type: 'ice',
                    from: this.peerId,
                    to: remotePeerId,
                    candidate: event.candidate
                });
            };

            pc.onconnectionstatechange = () => {
                const state = pc.connectionState;
                if (state === 'failed' || state === 'closed') {
                    if (mode === 'receiver') this.closeReceiver(remotePeerId);
                    else this.closePublisher(remotePeerId);
                }
            };

            return pc;
        }

        async ensureReceiver(remotePresence) {
            const remotePeerId = remotePresence.peer_id || remotePresence.peerId;
            const remotePublicId = Number(remotePresence.user_public_id || 0);

            if (!remotePeerId || remotePeerId === this.peerId) return;
            if (!remotePublicId || !this.isRemoteAuthorizedSpeaker(remotePublicId)) return;
            if (this.receiverPeers.has(remotePeerId)) return;

            const pc = this.newPeerConnection(remotePeerId, 'receiver');
            pc._zonoPublicId = remotePublicId;
            this.receiverPeers.set(remotePeerId, pc);

            pc.addTransceiver('audio', { direction: 'recvonly' });

            pc.ontrack = (event) => {
                const stream = event.streams?.[0] || new MediaStream([event.track]);
                this.attachRemoteAudio(remotePeerId, stream);
            };

            try {
                const offer = await pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: false
                });
                await pc.setLocalDescription(offer);

                await this.sendBroadcast('voice-signal', {
                    type: 'offer',
                    from: this.peerId,
                    to: remotePeerId,
                    from_public_id: this.myPublicId(),
                    sdp: pc.localDescription
                });
            } catch (_) {
                this.closeReceiver(remotePeerId);
            }
        }

        async handleOffer(msg) {
            if (!this.isPublishing || !this.localStream) return;
            if (!this.isMySeatActive()) return;

            const listenerPeerId = msg.from;
            if (!listenerPeerId || listenerPeerId === this.peerId) return;

            this.closePublisher(listenerPeerId);

            const pc = this.newPeerConnection(listenerPeerId, 'publisher');
            this.publisherPeers.set(listenerPeerId, pc);

            this.localStream.getAudioTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                await this.sendBroadcast('voice-signal', {
                    type: 'answer',
                    from: this.peerId,
                    to: listenerPeerId,
                    from_public_id: this.myPublicId(),
                    sdp: pc.localDescription
                });
            } catch (_) {
                this.closePublisher(listenerPeerId);
            }
        }

        async handleAnswer(msg) {
            const pc = this.receiverPeers.get(msg.from);
            if (!pc || !msg.sdp) return;
            try {
                if (pc.signalingState !== 'closed') {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                }
            } catch (_) {}
        }

        async handleIce(msg) {
            if (!msg.candidate) return;
            const pc = this.publisherPeers.get(msg.from) || this.receiverPeers.get(msg.from);
            if (!pc) return;
            try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (_) {}
        }

        async handleSignal(msg) {
            if (!msg || msg.to !== this.peerId) return;

            if (msg.type === 'offer') {
                await this.handleOffer(msg);
            } else if (msg.type === 'answer') {
                await this.handleAnswer(msg);
            } else if (msg.type === 'ice') {
                await this.handleIce(msg);
            }
        }

        async handleVoiceState(msg) {
            if (!msg || msg.peer_id === this.peerId) return;

            const publicId = Number(msg.user_public_id || 0);
            if (msg.on_mic && this.isRemoteAuthorizedSpeaker(publicId)) {
                await this.ensureReceiver({
                    peer_id: msg.peer_id,
                    user_public_id: publicId
                });
            } else {
                this.closeReceiver(msg.peer_id);
            }
        }

        getPresenceList() {
            if (!this.channel) return [];
            const state = this.channel.presenceState?.() || {};
            return Object.values(state).flat().filter(Boolean);
        }

        async handlePresenceSync() {
            if (!this.channel) return;

            const presences = this.getPresenceList();
            const livePeerIds = new Set();

            for (const p of presences) {
                const peerId = p.peer_id || p.peerId;
                if (!peerId || peerId === this.peerId) continue;
                livePeerIds.add(peerId);

                const publicId = Number(p.user_public_id || 0);
                if (p.on_mic && this.isRemoteAuthorizedSpeaker(publicId)) {
                    await this.ensureReceiver(p);
                } else {
                    this.closeReceiver(peerId);
                }
            }

            for (const peerId of [...this.receiverPeers.keys()]) {
                if (!livePeerIds.has(peerId)) this.closeReceiver(peerId);
            }
            for (const peerId of [...this.publisherPeers.keys()]) {
                if (!livePeerIds.has(peerId)) this.closePublisher(peerId);
            }
        }

        attachRemoteAudio(peerId, stream) {
            let audio = this.remoteAudios.get(peerId);
            if (!audio) {
                audio = document.createElement('audio');
                audio.autoplay = true;
                audio.playsInline = true;
                audio.setAttribute('playsinline', '');
                audio.setAttribute('data-zono-peer', peerId);
                audio.volume = 1;

                const sinks = document.getElementById('zono-live-audio-sinks') || document.body;
                sinks.appendChild(audio);
                this.remoteAudios.set(peerId, audio);
            }

            if (audio.srcObject !== stream) audio.srcObject = stream;

            const playPromise = audio.play?.();
            if (playPromise?.catch) {
                playPromise.catch(() => {
                    // Most Android/WebView sessions are already unlocked by the room tap.
                    // If autoplay is blocked, the next user interaction normally unlocks it.
                    this.setStatus('on', 'اضغط داخل الروم للصوت');
                    const unlock = () => {
                        audio.play?.().catch(() => {});
                        document.removeEventListener('click', unlock);
                        document.removeEventListener('touchstart', unlock);
                    };
                    document.addEventListener('click', unlock, { once: true });
                    document.addEventListener('touchstart', unlock, { once: true });
                });
            }
        }

        closeReceiver(peerId) {
            const pc = this.receiverPeers.get(peerId);
            if (pc) {
                try { pc.ontrack = null; pc.close(); } catch (_) {}
                this.receiverPeers.delete(peerId);
            }

            const audio = this.remoteAudios.get(peerId);
            if (audio) {
                try {
                    audio.pause();
                    audio.srcObject = null;
                    audio.remove();
                } catch (_) {}
                this.remoteAudios.delete(peerId);
            }
        }

        closePublisher(peerId) {
            const pc = this.publisherPeers.get(peerId);
            if (pc) {
                try { pc.close(); } catch (_) {}
                this.publisherPeers.delete(peerId);
            }
        }

        closePeer(peerId) {
            this.closeReceiver(peerId);
            this.closePublisher(peerId);
        }

        async leaveRoom() {
            if (this.localStream) {
                this.localStream.getTracks().forEach(t => {
                    try { t.stop(); } catch (_) {}
                });
            }
            this.localStream = null;
            this.isPublishing = false;
            this.isMuted = false;

            for (const peerId of [...this.receiverPeers.keys()]) this.closeReceiver(peerId);
            for (const peerId of [...this.publisherPeers.keys()]) this.closePublisher(peerId);

            if (this.channel && this.client) {
                try { await this.channel.untrack(); } catch (_) {}
                try { await this.client.removeChannel(this.channel); } catch (_) {}
            }

            this.channel = null;
            this.roomId = null;
            this._lastPresenceOnMic = null;
            this.setStatus('off', 'غير متصل');
        }
    }

    window.zonoLiveVoice = new ZonoLiveVoiceEngine();
})();
