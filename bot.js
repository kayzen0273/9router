const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const pino = require("pino");
const express = require("express");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;

let qrCodeData = null;
let isConnected = false;
let pairingCode = null;
let botSocket = null;
let pairingRequested = false;
let currentPhone = null;
const viewOnceCache = new Map();

// ==================== SERVER ====================
const server = app.listen(PORT, () => {
  console.log("✅ Server jalan di port " + PORT);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket konek");
  if (qrCodeData) {
    qrcode.toDataURL(qrCodeData).then(dataUrl => {
      ws.send(JSON.stringify({ type: "qr", qr: dataUrl }));
    });
  }
  if (pairingCode) {
    ws.send(JSON.stringify({ type: "pairing", code: pairingCode }));
  }
  if (isConnected) {
    ws.send(JSON.stringify({ type: "connected" }));
  }
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { 
    if (c.readyState === 1) c.send(msg); 
  });
}

// ==================== ENDPOINTS ====================
app.get("/status", (req, res) => {
  res.json({ 
    connected: isConnected, 
    qr: qrCodeData ? "ada" : null,
    pairing: pairingCode || null,
    phone: currentPhone,
    cacheSize: viewOnceCache.size
  });
});

app.get("/pair", async (req, res) => {
  if (!botSocket) {
    return res.json({ error: "Bot belum siap, tunggu 10 detik lalu coba lagi" });
  }
  if (botSocket.authState.creds.registered) {
    return res.json({ error: "Bot udah terdaftar, gak perlu pairing" });
  }
  
  const phone = req.query.phone;
  if (!phone) {
    return res.json({ error: "Kasih nomor: /pair?phone=62812..." });
  }
  
  try {
    const cleanPhone = phone.replace(/\D/g, '');
    currentPhone = cleanPhone;
    pairingRequested = false; // Reset biar bisa minta lagi
    
    console.log("🔑 Minta pairing code buat " + cleanPhone);
    const code = await botSocket.requestPairingCode(cleanPhone);
    pairingCode = code;
    console.log("🔑 Pairing code: " + code);
    broadcast({ type: "pairing", code: code });
    res.json({ code: code, phone: cleanPhone });
  } catch (e) {
    console.log("❌ Pair error:", e.message);
    res.json({ error: e.message });
  }
});

app.get("/reset", (req, res) => {
  try {
    if (fs.existsSync("auth_info")) {
      fs.rmSync("auth_info", { recursive: true, force: true });
      console.log("🗑️ Session lama dihapus");
    }
    res.json({ ok: true, message: "Session dihapus, bot akan restart" });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/cache", (req, res) => {
  const list = [];
  viewOnceCache.forEach((v, k) => {
    list.push({ jid: k, type: v.type, ts: v.ts });
  });
  res.json({ total: viewOnceCache.size, items: list });
});

app.get("/", (req, res) => {
  res.send(`
    <h2>WA RVO Bot</h2>
    <p><a href="/status">/status</a> — cek status</p>
    <p><a href="/pair?phone=62812XXXXXXX">/pair?phone=62812XXXXXXX</a> — minta kode pairing</p>
    <p><a href="/cache">/cache</a> — liat view once yang ketangkep</p>
    <p><a href="/reset">/reset</a> — hapus session (kalo stuck)</p>
  `);
});

// ==================== HELPER: DETEKSI VIEW ONCE ====================
function extractViewOnce(content) {
  // Cek semua kemungkinan format view once
  let vo = content.viewOnceMessageV2 || 
           content.viewOnceMessageV2Extension || 
           content.viewOnceMessage;
  
  // Cek di dalam ephemeralMessage
  if (!vo && content.ephemeralMessage?.message) {
    vo = content.ephemeralMessage.message.viewOnceMessageV2 || 
         content.ephemeralMessage.message.viewOnceMessageV2Extension || 
         content.ephemeralMessage.message.viewOnceMessage;
  }
  
  return vo;
}

function getMediaType(inner) {
  if (!inner) return null;
  if (inner.imageMessage) return "image";
  if (inner.videoMessage) return "video";
  if (inner.audioMessage) return "audio";
  return null;
}

// ==================== BOT ====================
async function startBot() {
  console.log("🚀 Mulai konek WhatsApp...");
  pairingRequested = false;
  
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  botSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  // ==================== CONNECTION ====================
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    console.log("📡 Status:", connection || "-");
    
    // Minta pairing code pas connecting
    if (connection === "connecting" && !pairingRequested && !sock.authState.creds.registered && currentPhone) {
      pairingRequested = true;
      console.log("🔑 Status connecting, minta pairing code...");
      try {
        await new Promise(r => setTimeout(r, 2000));
        const code = await sock.requestPairingCode(currentPhone);
        pairingCode = code;
        console.log("🔑 Pairing code: " + code);
        broadcast({ type: "pairing", code: code });
      } catch (e) {
        console.log("❌ Pairing error:", e.message);
        pairingRequested = false;
      }
    }
    
    if (qr) {
      console.log("📱 QR BARU");
      qrCodeData = qr;
      isConnected = false;
      const dataUrl = await qrcode.toDataURL(qr);
      broadcast({ type: "qr", qr: dataUrl });
    }
    
    if (connection === "open") {
      console.log("✅ WhatsApp terhubung!");
      isConnected = true;
      qrCodeData = null;
      pairingCode = null;
      pairingRequested = false;
      broadcast({ type: "connected" });
    }
    
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Tertutup, status:", statusCode);
      isConnected = false;
      pairingRequested = false;
      broadcast({ type: "disconnected" });
      
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("🚪 Logged out, hapus session...");
        if (fs.existsSync("auth_info")) {
          fs.rmSync("auth_info", { recursive: true, force: true });
        }
        setTimeout(() => startBot(), 3000);
      } else if (statusCode === 401 || statusCode === 515) {
        console.log("🔄 Restart required, reconnect...");
        setTimeout(() => startBot(), 3000);
      } else {
        console.log("🔄 Reconnect...");
        setTimeout(() => startBot(), 5000);
      }
    }
  });

  // ==================== MESSAGES ====================
  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const content = msg.message;
      if (!content) continue;
      
      // 🔍 DEBUG: Log SEMUA pesan masuk
      console.log("═══════════════════════════════");
      console.log("📩 PESAN MASUK dari " + jid);
      console.log("📋 Format keys:", Object.keys(content).join(", "));
      
      // Get text
      const text = content.conversation || 
                   content.extendedTextMessage?.text || 
                   content.ephemeralMessage?.message?.conversation ||
                   content.ephemeralMessage?.message?.extendedTextMessage?.text ||
                   "";
      
      // 🔥 DETEKSI VIEW ONCE
      const vo = extractViewOnce(content);
      
      if (vo) {
        console.log("🎯 VIEW ONCE TERDETEKSI!");
        const inner = vo.message;
        console.log("📦 Inner keys:", inner ? Object.keys(inner).join(", ") : "kosong");
        
        const type = getMediaType(inner);
        
        if (type) {
          viewOnceCache.set(jid, { 
            type, 
            content: inner, 
            ts: Date.now() 
          });
          console.log("✅ View once " + type + " DISIMPAN dari " + jid);
          console.log("📊 Cache size: " + viewOnceCache.size);
        } else {
          console.log("⚠️ Tipe media gak dikenal");
        }
      } else {
        // Log kalo bukan view once (biar tau formatnya)
        if (content.imageMessage) console.log("ℹ️ Ini image BIASA (bukan view once)");
        if (content.videoMessage) console.log("ℹ️ Ini video BIASA (bukan view once)");
      }
      
      // 🔥 COMMAND .rvo
      if (text.trim() === ".rvo") {
        console.log("🔍 Command .rvo dari " + jid);
        const cached = viewOnceCache.get(jid);
        
        if (!cached) {
          console.log("❌ Gak ada cache untuk " + jid);
          console.log("📊 Cache yang ada:", [...viewOnceCache.keys()].join(", ") || "kosong");
          await sock.sendMessage(jid, { text: "❌ Gak ada view once" });
          continue;
        }
        
        try {
          console.log("📤 Ngirim ulang " + cached.type);
          const buf = await sock.downloadMediaMessage({ message: cached.content });
          await sock.sendMessage(jid, {
            [cached.type]: buf,
            caption: "🔓 .rvo — Diambil dari View Once",
          });
          viewOnceCache.delete(jid);
          console.log("✅ Berhasil kirim ulang");
        } catch (e) {
          console.log("❌ Error:", e.message);
          await sock.sendMessage(jid, { text: "❌ Gagal: " + e.message });
        }
      }
      
      console.log("═══════════════════════════════");
    }
  });
}

startBot();
