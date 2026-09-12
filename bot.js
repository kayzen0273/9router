const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const pino = require("pino");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;

let qrData = null;
let connected = false;
const cache = new Map();

const server = app.listen(PORT, () => console.log("✅ Jalan di port " + PORT));
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Client konek");
  if (qrData) {
    qrcode.toDataURL(qrData).then(url => ws.send(JSON.stringify({ type: "qr", qr: url })));
  }
  if (connected) ws.send(JSON.stringify({ type: "connected" }));
});

function send(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

app.get("/status", (req, res) => {
  res.json({ connected, qr: qrData ? "ada" : null, cache: cache.size });
});

app.get("/", (req, res) => res.send("Bot jalan!"));

async function start() {
  console.log("🚀 Start...");
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    console.log("📡 " + (connection || "-"));
    
    if (qr) {
      qrData = qr;
      connected = false;
      const url = await qrcode.toDataURL(qr);
      send({ type: "qr", qr: url });
      console.log("📱 QR dikirim");
    }
    
    if (connection === "open") {
      connected = true;
      qrData = null;
      send({ type: "connected" });
      console.log("✅ WhatsApp konek!");
    }
    
    if (connection === "close") {
      connected = false;
      send({ type: "disconnected" });
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(start, 3000);
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
      
      console.log("📩 Pesan dari " + jid);
      console.log("📋 Keys:", Object.keys(content).join(", "));
      
      // Deteksi view once (semua format)
      let vo = content.viewOnceMessageV2 || 
               content.viewOnceMessageV2Extension || 
               content.viewOnceMessage;
      
      if (!vo && content.ephemeralMessage?.message) {
        vo = content.ephemeralMessage.message.viewOnceMessageV2 || 
             content.ephemeralMessage.message.viewOnceMessage;
      }
      
      if (vo && vo.message) {
        const inner = vo.message;
        const type = inner.imageMessage ? "image" : inner.videoMessage ? "video" : null;
        if (type) {
          cache.set(jid, { type, content: inner });
          console.log("📸 View once " + type + " DISIMPAN");
        }
      }
      
      if (text.trim() === ".rvo") {
        const c = cache.get(jid);
        if (!c) {
          await sock.sendMessage(jid, { text: "❌ Gak ada view once" });
          continue;
        }
        try {
          const buf = await sock.downloadMediaMessage({ message: c.content });
          await sock.sendMessage(jid, { [c.type]: buf, caption: "🔓 .rvo" });
          cache.delete(jid);
          console.log("✅ Terkirim");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Gagal: " + e.message });
        }
      }
    }
  });
}

start();
