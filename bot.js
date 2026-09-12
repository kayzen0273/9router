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
let botSocket = null;
const viewOnceCache = new Map();

// ==================== SERVER ====================
const server = app.listen(PORT, () => {
  console.log("✅ Server jalan di port " + PORT);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Client konek");
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

app.get("/status", (req, res) => {
  res.json({ connected: isConnected, qr: qrCodeData ? "ada" : null });
});

app.get("/", (req, res) => res.send("Bot jalan!"));

// ==================== HELPER ====================
function extractViewOnce(content) {
  let vo = content.viewOnceMessageV2 || 
           content.viewOnceMessageV2Extension || 
           content.viewOnceMessage;
  
  if (!vo && content.ephemeralMessage?.message) {
    vo = content.ephemeralMessage.message.viewOnceMessageV2 || 
         content.ephemeralMessage.message.viewOnceMessageV2Extension || 
         content.ephemeralMessage.message.viewOnceMessage;
  }
  return vo;
}

// ==================== BOT ====================
async function startBot() {
  console.log("🚀 Mulai konek WhatsApp...");
  
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  botSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
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
      broadcast({ type: "connected" });
    }
    if (connection === "close") {
      console.log("❌ Tertutup");
      isConnected = false;
      broadcast({ type: "disconnected" });
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
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
                   content.extendedTextMessage?.text || "";

      // 🔥 DETEKSI VIEW ONCE
      const vo = extractViewOnce(content);
      if (vo) {
        const inner = vo.message;
        if (inner) {
          const type = inner.imageMessage ? "image" : 
                       inner.videoMessage ? "video" : null;
          if (type) {
            viewOnceCache.set(jid, { type, content: inner, ts: Date.now() });
            console.log("📸 View once " + type + " DISIMPAN dari " + jid);
          }
        }
      }

      // 🔥 COMMAND .rvo
      if (text.trim() === ".rvo") {
        console.log("🔍 .rvo dari " + jid);
        const cached = viewOnceCache.get(jid);
        
        if (!cached) {
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
          console.log("✅ Berhasil");
        } catch (e) {
          console.log("❌ Error:", e.message);
          await sock.sendMessage(jid, { text: "❌ Gagal: " + e.message });
        }
      }
    }
  });
}

startBot();
