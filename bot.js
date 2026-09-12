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
let pairingCode = null;
let botSocket = null;
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

// ==================== HTTP ENDPOINTS ====================
app.get("/status", (req, res) => {
  res.json({ 
    connected: isConnected, 
    qr: qrCodeData ? "ada" : null,
    pairing: pairingCode || null
  });
});

app.get("/pair", async (req, res) => {
  if (!botSocket) {
    return res.json({ error: "Bot belum siap" });
  }
  if (botSocket.authState.creds.registered) {
    return res.json({ error: "Bot udah terdaftar" });
  }
  
  const phone = req.query.phone;
  if (!phone) {
    return res.json({ error: "Kasih nomor HP: /pair?phone=62812..." });
  }
  
  try {
    const code = await botSocket.requestPairingCode(phone.replace(/\D/g, ''));
    pairingCode = code;
    console.log("🔑 Pairing code: " + code);
    broadcast({ type: "pairing", code: code });
    res.json({ code: code });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h2>WA RVO Bot</h2>
    <p><a href="/status">/status</a> — cek status</p>
    <p><a href="/pair?phone=62812XXXXXXX">/pair?phone=62812XXXXXXX</a> — minta kode pairing</p>
  `);
});

// ==================== HELPER: DETEKSI VIEW ONCE ====================
function extractViewOnce(content) {
  let vo = content.viewOnceMessageV2 || 
           content.viewOnceMessageV2Extension || 
           content.viewOnceMessage;
  
  if (!vo && content.ephemeralMessage?.message) {
    vo = content.ephemeralMessage.message.viewOnceMessageV2 || 
         content.ephemeralMessage.message.viewOnceMessageV2Extension || 
         content.ephemeralMessage.message.viewOnceMessage;
  }
  
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
    printQRInTerminal: false,  // ← MATIIN QR, PAKE PAIRING
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  botSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !sock.authState.creds.registered) {
      console.log("📱 QR muncul — tapi lo bisa pake /pair?phone=...");
      qrCodeData = qr;
      const dataUrl = await qrcode.toDataURL(qr);
      broadcast({ type: "qr", qr: dataUrl });
    }
    
    if (connection === "open") {
      console.log("✅ WhatsApp terhubung!");
      isConnected = true;
      qrCodeData = null;
      pairingCode = null;
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
      
      const text = content.conversation || 
                   content.extendedTextMessage?.text || 
                   content.ephemeralMessage?.message?.conversation ||
                   content.ephemeralMessage?.message?.extendedTextMessage?.text ||
                   "";

      const vo = extractViewOnce(content);
      
      if (vo) {
        const inner = vo.message;
        if (inner) {
          const type = inner.imageMessage ? "image" : 
                       inner.videoMessage ? "video" : null;
          if (type) {
            viewOnceCache.set(jid, { type, content: inner, ts: Date.now() });
            console.log("✅ View once " + type + " DISIMPAN dari " + jid);
          }
        }
      }

      if (text.trim() === ".rvo") {
        const cached = viewOnceCache.get(jid);
        if (!cached) {
          await sock.sendMessage(jid, { text: "❌ Gak ada view once" });
          continue;
        }
        try {
          const buf = await sock.downloadMediaMessage({ message: cached.content });
          await sock.sendMessage(jid, {
            [cached.type]: buf,
            caption: "🔓 .rvo — Diambil dari View Once",
          });
          viewOnceCache.delete(jid);
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Gagal ambil media" });
        }
      }
    }
  });
}

startBot();
