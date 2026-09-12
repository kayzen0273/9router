const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason 
} = require("@whiskeysockets/baileys");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const pino = require("pino");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;

let qrCodeData = null;
let isConnected = false;
const viewOnceCache = new Map();

// ==================== HTTP + WEBSOCKET SERVER ====================
const server = app.listen(PORT, () => {
  console.log("Server jalan di port " + PORT);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Client WebSocket konek");
  if (qrCodeData) {
    qrcode.toDataURL(qrCodeData).then(dataUrl => {
      ws.send(JSON.stringify({ type: "qr", qr: dataUrl }));
    });
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

// ==================== HTTP ENDPOINTS ====================
app.get("/status", (req, res) => {
  res.json({ connected: isConnected, qr: qrCodeData ? "ada" : null });
});

app.get("/", (req, res) => {
  res.send("WA RVO Bot Server — Jalan!");
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
  
  // Cek di dalam viewOnceMessageV2.message (nested)
  if (vo && !vo.message && vo.viewOnceMessageV2) {
    vo = vo.viewOnceMessageV2;
  }
  
  return vo;
}

// ==================== WHATSAPP BOT ====================
async function startBot() {
  console.log("🚀 Mulai konek ke WhatsApp...");
  
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("📱 QR BARU DITERIMA, ngirim ke client...");
      qrCodeData = qr;
      isConnected = false;
      const dataUrl = await qrcode.toDataURL(qr);
      broadcast({ type: "qr", qr: dataUrl });
      console.log("✅ QR dikirim ke WebSocket client");
    }
    if (connection === "open") {
      console.log("✅ WhatsApp terhubung!");
      isConnected = true;
      qrCodeData = null;
      broadcast({ type: "connected" });
    }
    if (connection === "close") {
      console.log("❌ Koneksi tertutup");
      isConnected = false;
      broadcast({ type: "disconnected" });
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconnect...");
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const content = msg.message;
      if (!content) continue;
      
      // Get text
      const text = content.conversation || 
                   content.extendedTextMessage?.text || 
                   content.ephemeralMessage?.message?.conversation ||
                   content.ephemeralMessage?.message?.extendedTextMessage?.text ||
                   "";

      // 🔍 DEBUG: Log semua pesan masuk
      console.log("📩 PESAN MASUK dari " + jid);
      console.log("📋 Format:", Object.keys(content).join(", "));
      
      // 🔥 DETEKSI VIEW ONCE (pake helper)
      const vo = extractViewOnce(content);
      
      if (vo) {
        console.log("🎯 VIEW ONCE TERDETEKSI!");
        const inner = vo.message;
        console.log("📦 Inner keys:", inner ? Object.keys(inner).join(", ") : "kosong");
        
        if (inner) {
          const type = inner.imageMessage ? "image" : 
                       inner.videoMessage ? "video" : 
                       inner.audioMessage ? "audio" : null;
          
          if (type) {
            viewOnceCache.set(jid, { type, content: inner, ts: Date.now() });
            console.log("✅ View once " + type + " DISIMPAN dari " + jid);
            broadcast({ type: "log", message: "📸 View once " + type + " tertangkap" });
          } else {
            console.log("⚠️ Tipe media gak dikenal:", Object.keys(inner).join(", "));
          }
        }
      }

      // 🔥 COMMAND .rvo
      if (text.trim() === ".rvo") {
        console.log("🔍 Command .rvo dari " + jid);
        const cached = viewOnceCache.get(jid);
        
        if (!cached) {
          console.log("❌ Gak ada cache untuk " + jid);
          await sock.sendMessage(jid, { text: "❌ Gak ada view once" });
          continue;
        }
        
        try {
          console.log("📤 Ngirim ulang " + cached.type + " ke " + jid);
          const buf = await sock.downloadMediaMessage({ message: cached.content });
          await sock.sendMessage(jid, {
            [cached.type]: buf,
            caption: "🔓 .rvo — Diambil dari View Once",
          });
          viewOnceCache.delete(jid);
          console.log("✅ Berhasil kirim ulang");
        } catch (e) {
          console.log("❌ Gagal ambil media:", e.message);
          await sock.sendMessage(jid, { text: "❌ Gagal ambil media: " + e.message });
        }
      }
    }
  });
}

startBot();
