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
  console.log("Client WebSocket konek");
  // Kirim QR kalau udah ada
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

// ==================== WHATSAPP BOT ====================
async function startBot() {
  console.log("Mulai konek ke WhatsApp...");
  
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
      const text = content.conversation || content.extendedTextMessage?.text || "";

      const vo = content.viewOnceMessageV2 || content.viewOnceMessage;
      if (vo) {
        const inner = vo.message;
        const type = inner?.imageMessage ? "image" : inner?.videoMessage ? "video" : null;
        if (type) {
          viewOnceCache.set(jid, { type, content: inner });
          console.log("📸 View once " + type + " dari " + jid);
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
