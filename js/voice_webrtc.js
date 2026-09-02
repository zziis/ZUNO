/*
 * ZONO Live Voice Engine v2
 * Free P2P WebRTC + Supabase Realtime signalling.
 * Fixes:
 * - ICE candidate buffering until remoteDescription exists.
 * - Explicit candidate.toJSON() for reliable Realtime serialization.
 * - Retry offers when a speaker/listener appears.
 * - Connection/ICE diagnostics visible in room.
 * - Audio autoplay unlock handling.
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

            this.receiverPeers = new Map();
            this.publisherPeers = new Map();
            this.remoteAudios = new Map();

            // peerId -> RTCIceCandidateInit[]
            this.pendingIce = new Map();

            this.iceServers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ];

            this._joining = null;
            this._lastPresenceOnMic = null;
            this._offerRetry = new Map();
            this._lastRemoteAudioAt = null;
            this._audioUnlocked = false;

            this.installAudioUnlock();
        }

        get app() {
            return window.zonoApp || null;
        }

        get client() {
            return window.zunoBackend?.client || window.zunoAuth?.client || null;
        }

        makePeerId() {
            if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
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
            return !!(state?.active && myId && Array.isArray(state.seats) &&
                state.seats.some(s => Number(s.user_public_id) === myId));
        }

        isRemoteAuthorizedSpeaker(publicId) {
            const state = this.app?.roomMicState;
            return !!(state?.active && Array.isArray(state.seats) &&
                state.seats.some(s => Number(s.user_public_id) === Number(publicId)));
        }

        setStatus(state, text) {
            this.app?.updateLiveAudioStatus?.(state, text);
        }

        installAudioUnlock() {
            const unlock = () => {
                this._audioUnlocked = true;
                for (const audio of this.remoteAudios.values()) {
                    try {
                        const p = audio.play?.();
                        if (p?.catch) p.catch(()=>{});
                    } catch (_) {}
                }
            };
            document.addEventListener('click', unlock, { passive:true });
            document.addEventListener('touchstart', unlock, { passive:true });
        }

        async joinRoom(roomId) {
            roomId = Number(roomId);
            if (!roomId || !this.client) return;

            if (this.roomId === roomId && this.channel) return;

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

            ch.on('broadcast', { event:'voice-signal' }, ({payload}) => {
                this.handleSignal(payload).catch(()=>{});
            });
            ch.on('broadcast', { event:'voice-state' }, ({payload}) => {
                this.handleVoiceState(payload).catch(()=>{});
            });
            ch.on('presence', { event:'sync' }, () => {
                this.handlePresenceSync().catch(()=>{});
            });
            ch.on('presence', { event:'leave' }, ({leftPresences}) => {
                (leftPresences || []).forEach(p => {
                    const peer = p.peer_id || p.peerId;
                    if (peer) this.closePeer(peer);
                });
            });

            await new Promise((resolve,reject) => {
                let done=false;
                const timer=setTimeout(()=>{
                    if(!done){done=true;reject(new Error('Realtime timeout'))}
                },10000);

                ch.subscribe(async(status,err)=>{
                    if(done) return;
                    if(status==='SUBSCRIBED'){
                        done=true; clearTimeout(timer);
                        try { await this.updatePresence(true); } catch (_) {}
                        resolve();
                    } else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){
                        done=true; clearTimeout(timer);
                        reject(err||new Error(status));
                    }
                });
            }).catch(e=>{
                this.setStatus('error','فشل Realtime');
                throw e;
            });

            this.setStatus('on','الصوت متصل');
            await this.syncMicState();
            await this.handlePresenceSync();
        }

        async sendBroadcast(event,payload) {
            if(!this.channel) return;
            try {
                await this.channel.send({type:'broadcast',event,payload});
            } catch (_) {}
        }

        async updatePresence(force=false) {
            if(!this.channel) return;
            const onMic=this.isMySeatActive();
            if(!force && this._lastPresenceOnMic===onMic) return;
            this._lastPresenceOnMic=onMic;

            await this.channel.track({
                peer_id:this.peerId,
                user_public_id:this.myPublicId(),
                display_name:this.myName(),
                on_mic:onMic,
                updated_at:new Date().toISOString()
            });

            await this.sendBroadcast('voice-state',{
                peer_id:this.peerId,
                user_public_id:this.myPublicId(),
                on_mic:onMic
            });
        }

        async syncMicState() {
            if(!this.channel||!this.roomId) return;

            const shouldPublish=this.isMySeatActive();
            if(shouldPublish && !this.isPublishing) await this.startPublishing();
            else if(!shouldPublish && this.isPublishing) await this.stopPublishing();

            await this.updatePresence();
            await this.handlePresenceSync();

            for(const [peerId,pc] of this.receiverPeers.entries()){
                const publicId=pc._zonoPublicId;
                if(publicId && !this.isRemoteAuthorizedSpeaker(publicId)){
                    this.closeReceiver(peerId);
                }
            }
        }

        async startPublishing() {
            if(this.isPublishing) return;

            if(!navigator.mediaDevices?.getUserMedia){
                this.setStatus('error','الميكروفون غير مدعوم');
                this.app?.showToast?.('هذا الجهاز لا يدعم الوصول للميكروفون','error');
                return;
            }

            try {
                this.setStatus('connecting','تشغيل المايك');

                const stream=await navigator.mediaDevices.getUserMedia({
                    audio:{
                        echoCancellation:true,
                        noiseSuppression:true,
                        autoGainControl:true,
                        channelCount:1
                    },
                    video:false
                });

                this.localStream=stream;
                this.isPublishing=true;
                this.isMuted=false;

                for(const track of stream.getAudioTracks()){
                    track.enabled=true;
                    track.onended=()=>this.stopPublishing().catch(()=>{});
                }

                this.setStatus('on','مايك مباشر');
                await this.updatePresence(true);
                await this.handlePresenceSync();
            } catch(e) {
                this.isPublishing=false;
                this.localStream=null;
                this.setStatus('error','اسمح بالميكروفون');
                this.app?.showToast?.('اسمح للتطبيق باستخدام الميكروفون حتى يعمل الصوت المباشر','error');
            }
        }

        async stopPublishing() {
            this.isPublishing=false;
            if(this.localStream){
                this.localStream.getTracks().forEach(t=>{try{t.stop()}catch(_){}})
            }
            this.localStream=null;
            this.isMuted=false;

            for(const id of [...this.publisherPeers.keys()]) this.closePublisher(id);
            await this.updatePresence(true);
            if(this.roomId) this.setStatus('on','الصوت متصل');
        }

        toggleMute() {
            if(!this.localStream) return true;
            this.isMuted=!this.isMuted;
            this.localStream.getAudioTracks().forEach(t=>t.enabled=!this.isMuted);
            return this.isMuted;
        }

        newPeerConnection(remotePeerId,mode) {
            const pc=new RTCPeerConnection({iceServers:this.iceServers});

            pc.onicecandidate=(event)=>{
                if(!event.candidate) return;
                const candidate = event.candidate.toJSON
                    ? event.candidate.toJSON()
                    : {
                        candidate:event.candidate.candidate,
                        sdpMid:event.candidate.sdpMid,
                        sdpMLineIndex:event.candidate.sdpMLineIndex,
                        usernameFragment:event.candidate.usernameFragment
                    };

                this.sendBroadcast('voice-signal',{
                    type:'ice',
                    from:this.peerId,
                    to:remotePeerId,
                    candidate
                });
            };

            pc.oniceconnectionstatechange=()=>{
                const st=pc.iceConnectionState;
                if(st==='failed'||st==='closed'){
                    if(mode==='receiver') this.closeReceiver(remotePeerId);
                    else this.closePublisher(remotePeerId);
                }
            };

            pc.onconnectionstatechange=()=>{
                const st=pc.connectionState;
                if(st==='connected'){
                    this.setStatus('on','الصوت مباشر');
                } else if(st==='failed'){
                    this.setStatus('error','فشل WebRTC');
                }
            };

            return pc;
        }

        async flushPendingIce(peerId,pc) {
            if(!pc?.remoteDescription) return;
            const list=this.pendingIce.get(peerId)||[];
            if(!list.length) return;

            for(const init of list){
                try { await pc.addIceCandidate(new RTCIceCandidate(init)); } catch (_) {}
            }
            this.pendingIce.delete(peerId);
        }

        queueIce(peerId,candidate) {
            if(!peerId||!candidate) return;
            const list=this.pendingIce.get(peerId)||[];
            list.push(candidate);
            this.pendingIce.set(peerId,list.slice(-50));
        }

        async ensureReceiver(remotePresence,force=false) {
            const remotePeerId=remotePresence.peer_id||remotePresence.peerId;
            const remotePublicId=Number(remotePresence.user_public_id||0);
            if(!remotePeerId||remotePeerId===this.peerId) return;
            if(!remotePublicId||!this.isRemoteAuthorizedSpeaker(remotePublicId)) return;

            const existing=this.receiverPeers.get(remotePeerId);
            if(existing && !force){
                const st=existing.connectionState;
                if(st==='connected'||st==='connecting'||st==='new') return;
            }
            if(existing) this.closeReceiver(remotePeerId);

            const pc=this.newPeerConnection(remotePeerId,'receiver');
            pc._zonoPublicId=remotePublicId;
            this.receiverPeers.set(remotePeerId,pc);

            pc.addTransceiver('audio',{direction:'recvonly'});
            pc.ontrack=(event)=>{
                const stream=event.streams?.[0]||new MediaStream([event.track]);
                this._lastRemoteAudioAt=Date.now();
                this.attachRemoteAudio(remotePeerId,stream);
            };

            try {
                const offer=await pc.createOffer();
                await pc.setLocalDescription(offer);

                await this.sendBroadcast('voice-signal',{
                    type:'offer',
                    from:this.peerId,
                    to:remotePeerId,
                    from_public_id:this.myPublicId(),
                    sdp:{
                        type:pc.localDescription.type,
                        sdp:pc.localDescription.sdp
                    }
                });

                this.scheduleOfferRetry(remotePresence);
            } catch(_) {
                this.closeReceiver(remotePeerId);
            }
        }

        scheduleOfferRetry(remotePresence) {
            const peerId=remotePresence.peer_id||remotePresence.peerId;
            if(!peerId) return;
            clearTimeout(this._offerRetry.get(peerId));
            const timer=setTimeout(()=>{
                const pc=this.receiverPeers.get(peerId);
                if(!pc) return;
                const st=pc.connectionState;
                if(st!=='connected' && st!=='closed'){
                    this.ensureReceiver(remotePresence,true).catch(()=>{});
                }
            },3500);
            this._offerRetry.set(peerId,timer);
        }

        async handleOffer(msg) {
            if(!this.isPublishing||!this.localStream||!this.isMySeatActive()) return;

            const listenerPeerId=msg.from;
            if(!listenerPeerId||listenerPeerId===this.peerId||!msg.sdp) return;

            this.closePublisher(listenerPeerId);

            const pc=this.newPeerConnection(listenerPeerId,'publisher');
            this.publisherPeers.set(listenerPeerId,pc);

            this.localStream.getAudioTracks().forEach(track=>{
                pc.addTrack(track,this.localStream);
            });

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                await this.flushPendingIce(listenerPeerId,pc);

                const answer=await pc.createAnswer();
                await pc.setLocalDescription(answer);

                await this.sendBroadcast('voice-signal',{
                    type:'answer',
                    from:this.peerId,
                    to:listenerPeerId,
                    from_public_id:this.myPublicId(),
                    sdp:{
                        type:pc.localDescription.type,
                        sdp:pc.localDescription.sdp
                    }
                });
            } catch(_) {
                this.closePublisher(listenerPeerId);
            }
        }

        async handleAnswer(msg) {
            const pc=this.receiverPeers.get(msg.from);
            if(!pc||!msg.sdp) return;

            try {
                if(pc.signalingState!=='closed'){
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    await this.flushPendingIce(msg.from,pc);
                }
            } catch(_) {}
        }

        async handleIce(msg) {
            if(!msg?.candidate||!msg.from) return;

            const pc=this.publisherPeers.get(msg.from)||this.receiverPeers.get(msg.from);
            if(!pc || !pc.remoteDescription){
                this.queueIce(msg.from,msg.candidate);
                return;
            }

            try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch(_) {
                this.queueIce(msg.from,msg.candidate);
            }
        }

        async handleSignal(msg) {
            if(!msg||msg.to!==this.peerId) return;
            if(msg.type==='offer') await this.handleOffer(msg);
            else if(msg.type==='answer') await this.handleAnswer(msg);
            else if(msg.type==='ice') await this.handleIce(msg);
        }

        async handleVoiceState(msg) {
            if(!msg||msg.peer_id===this.peerId) return;
            const publicId=Number(msg.user_public_id||0);

            if(msg.on_mic && this.isRemoteAuthorizedSpeaker(publicId)){
                await this.ensureReceiver({
                    peer_id:msg.peer_id,
                    user_public_id:publicId
                });
            } else {
                this.closeReceiver(msg.peer_id);
            }
        }

        getPresenceList() {
            if(!this.channel) return [];
            const state=this.channel.presenceState?.()||{};
            return Object.values(state).flat().filter(Boolean);
        }

        async handlePresenceSync() {
            if(!this.channel) return;

            const presences=this.getPresenceList();
            const live=new Set();

            for(const p of presences){
                const peerId=p.peer_id||p.peerId;
                if(!peerId||peerId===this.peerId) continue;
                live.add(peerId);

                const publicId=Number(p.user_public_id||0);
                if(p.on_mic && this.isRemoteAuthorizedSpeaker(publicId)){
                    await this.ensureReceiver(p);
                } else {
                    this.closeReceiver(peerId);
                }
            }

            for(const id of [...this.receiverPeers.keys()]){
                if(!live.has(id)) this.closeReceiver(id);
            }
            for(const id of [...this.publisherPeers.keys()]){
                if(!live.has(id)) this.closePublisher(id);
            }
        }

        attachRemoteAudio(peerId,stream) {
            let audio=this.remoteAudios.get(peerId);
            if(!audio){
                audio=document.createElement('audio');
                audio.autoplay=true;
                audio.playsInline=true;
                audio.setAttribute('playsinline','');
                audio.setAttribute('data-zono-peer',peerId);
                audio.volume=1;

                const sinks=document.getElementById('zono-live-audio-sinks')||document.body;
                sinks.appendChild(audio);
                this.remoteAudios.set(peerId,audio);
            }

            audio.srcObject=stream;

            const tryPlay=()=>{
                const p=audio.play?.();
                if(p?.catch){
                    p.catch(()=>{
                        this.setStatus('on','اضغط داخل الروم للصوت');
                    });
                }
            };

            tryPlay();
            if(this._audioUnlocked) setTimeout(tryPlay,100);
        }

        closeReceiver(peerId) {
            clearTimeout(this._offerRetry.get(peerId));
            this._offerRetry.delete(peerId);

            const pc=this.receiverPeers.get(peerId);
            if(pc){
                try{pc.ontrack=null;pc.close()}catch(_){}
                this.receiverPeers.delete(peerId);
            }

            const audio=this.remoteAudios.get(peerId);
            if(audio){
                try{audio.pause();audio.srcObject=null;audio.remove()}catch(_){}
                this.remoteAudios.delete(peerId);
            }
        }

        closePublisher(peerId) {
            const pc=this.publisherPeers.get(peerId);
            if(pc){
                try{pc.close()}catch(_){}
                this.publisherPeers.delete(peerId);
            }
        }

        closePeer(peerId) {
            this.closeReceiver(peerId);
            this.closePublisher(peerId);
            this.pendingIce.delete(peerId);
        }

        async getDiagnostics() {
            let micPermission='unknown';
            try {
                if(navigator.permissions?.query){
                    micPermission=(await navigator.permissions.query({name:'microphone'})).state;
                }
            } catch (_) {}

            const allPeers=[
                ...this.receiverPeers.values(),
                ...this.publisherPeers.values()
            ];

            const iceStates=allPeers.map(pc=>pc.iceConnectionState||'new');
            const connStates=allPeers.map(pc=>pc.connectionState||'new');
            const connectedCount=connStates.filter(x=>x==='connected').length;

            const realtimeOk=!!this.channel && !!this.roomId;
            const micOk=this.isPublishing && !!this.localStream &&
                this.localStream.getAudioTracks().some(t=>t.readyState==='live');

            const iceGood=iceStates.some(x=>x==='connected'||x==='completed');
            const audioGood=[...this.remoteAudios.values()].some(a=>
                !!a.srcObject && a.srcObject.getAudioTracks().some(t=>t.readyState==='live')
            );

            let summary='الاتصال جاهز.';
            if(!realtimeOk) summary='Realtime غير متصل بالروم.';
            else if(this.isMySeatActive() && !micOk) summary='أنت على المايك لكن الميكروفون لم يبدأ؛ افحص صلاحية الميكروفون.';
            else if(this.getPresenceList().filter(p=>p.peer_id!==this.peerId).length>0 && !allPeers.length)
                summary='يوجد مستخدمون في الروم لكن لم يتكوّن Peer بعد؛ أعد الصعود للمايك.';
            else if(allPeers.length && !iceGood) summary='تم إنشاء WebRTC لكن ICE لم يتصل؛ الشبكة قد تمنع P2P المباشر.';
            else if(connectedCount>0 && !audioGood && !this.isPublishing) summary='الاتصال قائم لكن لم يصل Audio Track بعد.';
            else if(connectedCount>0) summary='WebRTC متصل. إذا لا تسمع، اضغط مرة داخل الروم لفتح تشغيل الصوت.';
            else if(!allPeers.length) summary='لا يوجد طرف صوتي آخر متصل حالياً. اختبر بحساب ثانٍ داخل نفس الروم.';

            return {
                microphone:{
                    ok:micOk || !this.isMySeatActive(),
                    label:this.isMySeatActive()
                        ? (micOk?'يعمل':`لا يعمل (${micPermission})`)
                        : `غير مطلوب (${micPermission})`
                },
                realtime:{ok:realtimeOk,label:realtimeOk?'متصل':'غير متصل'},
                webrtc:{ok:connectedCount>0,label:allPeers.length?`${connectedCount}/${allPeers.length} متصل`:'لا يوجد Peer'},
                ice:{ok:iceGood,label:iceStates.length?iceStates.join(', '):'—'},
                remoteAudio:{ok:audioGood,label:audioGood?'Audio Track موجود':'لا يوجد'},
                peerCount:allPeers.length,
                summary
            };
        }

        async leaveRoom() {
            if(this.localStream){
                this.localStream.getTracks().forEach(t=>{try{t.stop()}catch(_){}})
            }
            this.localStream=null;
            this.isPublishing=false;
            this.isMuted=false;

            for(const id of [...this.receiverPeers.keys()]) this.closeReceiver(id);
            for(const id of [...this.publisherPeers.keys()]) this.closePublisher(id);

            this.pendingIce.clear();
            for(const t of this._offerRetry.values()) clearTimeout(t);
            this._offerRetry.clear();

            if(this.channel&&this.client){
                try{await this.channel.untrack()}catch(_){}
                try{await this.client.removeChannel(this.channel)}catch(_){}
            }

            this.channel=null;
            this.roomId=null;
            this._lastPresenceOnMic=null;
            this.setStatus('off','غير متصل');
        }
    }

    window.zonoLiveVoice = new ZonoLiveVoiceEngine();
})();
