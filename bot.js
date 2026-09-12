const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

// ==================== STATE ====================
let sock = null;
let latestQR = null;
let pairingCode = null;
let isConnected = false;
let phoneNumber = null;
let logs = [];

// ==================== LOGGER ====================
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    const log = `[${time}] ${msg}`;
    logs.push(log);
    if (logs.length > 50) logs.shift();
    console.log(log);
}

// ==================== CONNECT WA ====================
async function connectToWhatsApp(usePairing = false, phone = null) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    // ==================== PAIRING CODE ====================
    if (usePairing && phone && !sock.authState.creds.registered) {
        try {
            // Format nomor: 628xxx (tanpa + dan tanpa 0 di depan)
            let cleanPhone = phone.replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
            
            addLog(`📱 Request pairing code buat: ${cleanPhone}`);
            
            // Delay dikit biar socket ready
            await new Promise(r => setTimeout(r, 2000));
            
            const code = await sock.requestPairingCode(cleanPhone);
            pairingCode = code;
            phoneNumber = cleanPhone;
            addLog(`✅ Pairing code: ${code}`);
        } catch (e) {
            addLog(`❌ Gagal request pairing code: ${e.message}`);
            pairingCode = null;
        }
    }

    // ==================== CONNECTION UPDATE ====================
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            isConnected = false;
            addLog('📱 QR Code baru tersedia');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            addLog(`❌ Connection closed. Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            pairingCode = null;
            addLog('✅ BOT CONNECTED!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ==================== HANDLE PESAN ====================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || '';

        addLog(`📩 ${from}: ${text}`);

        if (text === '.ping') {
            await sock.sendMessage(from, { text: '🏓 Pong!' });
        }
        if (text === '.menu') {
            await sock.sendMessage(from, { 
                text: '🔥 *BOT MENU*\n\n.ping - Cek bot\n.menu - Menu ini' 
            }, { quoted: msg });
        }
    });

    return sock;
}

// ==================== API ENDPOINTS ====================

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

// Request Pairing Code
app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor wajib diisi' });

    try {
        // Reset dulu
        pairingCode = null;
        
        // Kalo udah connected, logout dulu
        if (sock && isConnected) {
            await sock.logout();
            isConnected = false;
        }

        // Hapus auth lama biar fresh
        if (fs.existsSync('auth_info')) {
            fs.rmSync('auth_info', { recursive: true, force: true });
        }

        // Connect ulang dengan pairing
        await connectToWhatsApp(true, phone);

        // Tunggu pairing code muncul (max 10 detik)
        let waited = 0;
        while (!pairingCode && waited < 10000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }

        if (pairingCode) {
            res.json({ status: 'ok', code: pairingCode, phone });
        } else {
            res.status(500).json({ error: 'Gagal generate pairing code. Coba lagi.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Kirim pesan
app.post('/api/send', async (req, res) => {
    const { target, message } = req.body;
    if (!sock || !isConnected) return res.status(400).json({ error: 'Bot belum connected' });
    if (!target || !message) return res.status(400).json({ error: 'Target & message wajib' });

    try {
        const formattedTarget = target.includes('@') ? target : target + '@s.whatsapp.net';
        await sock.sendMessage(formattedTarget, { text: message });
        addLog(`✅ Pesan terkirim ke ${target}`);
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Logs
app.get('/api/logs', (req, res) => {
    res.json({ logs });
});

// Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        isConnected = false;
        if (fs.existsSync('auth_info')) {
            fs.rmSync('auth_info', { recursive: true, force: true });
        }
        addLog('🚪 Logout');
        res.json({ status: 'ok' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== FRONTEND ====================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==================== START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🔥 Server jalan di port', PORT);
    connectToWhatsApp();
});
