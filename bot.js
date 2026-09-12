const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ==================== SUPABASE ====================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zwqwomfrgtqyaiiugryg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3cXdvbWZyZ3RxeWFpaXVncnlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDUzODAsImV4cCI6MjEwNDc4MTM4MH0.Zs2egViPPVec5OeAUgCI0-nUG1ABCDi2fyhVTvHNmao';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== STATE ====================
let sock = null;
let latestQR = null;
let pairingCode = null;
let isConnected = false;
let phoneNumber = null;

// ==================== CONNECT WA ====================
async function connectToWhatsApp(usePairing = false, phone = null) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    // Pairing Code
    if (usePairing && phone && !sock.authState.creds.registered) {
        try {
            let cleanPhone = phone.replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
            await new Promise(r => setTimeout(r, 2000));
            const code = await sock.requestPairingCode(cleanPhone);
            pairingCode = code;
            phoneNumber = cleanPhone;
        } catch (e) {
            console.error('Pairing error:', e);
        }
    }

    // Connection Update
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQR = qr;
            isConnected = false;
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            pairingCode = null;
            console.log('✅ BOT CONNECTED!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==================== HANDLE PESAN MASUK ====================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

        // ==================== DETEKSI VIEW ONCE ====================
        // Cek apakah ini view once message
        const isViewOnce = msg.message.viewOnceMessage || 
                          msg.message.viewOnceMessageV2 ||
                          msg.message.viewOnceMessageV2Extension;

        if (isViewOnce) {
            console.log('📸 VIEW ONCE detected from:', from);
            
            try {
                // Extract view once content
                const viewOnceContent = isViewOnce.message;
                
                // Download media
                const buffer = await downloadMediaMessage(
                    { message: viewOnceContent, key: msg.key },
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );

                // Simpan ke Supabase
                const fileName = `viewonce_${Date.now()}.jpg`;
                const { data, error } = await supabase.storage
                    .from('viewonce')
                    .upload(fileName, buffer, { contentType: 'image/jpeg' });

                if (!error) {
                    // Dapetin public URL
                    const { data: urlData } = supabase.storage
                        .from('viewonce')
                        .getPublicUrl(fileName);

                    // Simpan metadata ke database
                    await supabase.from('viewonce_messages').insert({
                        sender: from,
                        media_url: urlData.publicUrl,
                        media_type: viewOnceContent.imageMessage ? 'image' : 'video',
                        timestamp: new Date()
                    });

                    console.log('✅ View once saved:', urlData.publicUrl);
                }
            } catch (e) {
                console.error('❌ Gagal download view once:', e.message);
            }
        }

        // Command sederhana
        if (text === '.ping') {
            await sock.sendMessage(from, { text: '🏓 Pong!' });
        }
    });

    return sock;
}

// ==================== API ENDPOINTS ====================

const app = express();
app.use(express.json());

// Status
app.get('/api/status', (req, res) => {
    res.json({ 
        connected: isConnected, 
        hasQR: !!latestQR,
        hasPairing: !!pairingCode,
        phone: phoneNumber
    });
});

// QR Code
app.get('/api/qr', async (req, res) => {
    if (!latestQR) return res.json({ qr: null });
    const qrImage = await qrcode.toDataURL(latestQR);
    res.json({ qr: qrImage });
});

// Pairing Code
app.get('/api/pairing', (req, res) => {
    res.json({ code: pairingCode, phone: phoneNumber });
});

// Request Pairing
app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor wajib' });

    try {
        if (sock && isConnected) await sock.logout();
        if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
        
        await connectToWhatsApp(true, phone);
        
        let waited = 0;
        while (!pairingCode && waited < 10000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }

        if (pairingCode) {
            res.json({ status: 'ok', code: pairingCode, phone });
        } else {
            res.status(500).json({ error: 'Gagal generate pairing code' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Kirim Pesan
app.post('/api/send', async (req, res) => {
    const { target, message } = req.body;
    if (!sock || !isConnected) return res.status(400).json({ error: 'Bot belum connected' });

    try {
        const formattedTarget = target.includes('@') ? target : target + '@s.whatsapp.net';
        await sock.sendMessage(formattedTarget, { text: message });
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get View Once List
app.get('/api/viewonce', async (req, res) => {
    const { data, error } = await supabase
        .from('viewonce_messages')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(50);
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data });
});

// Frontend
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🔥 Server jalan di port', PORT);
    connectToWhatsApp();
});
