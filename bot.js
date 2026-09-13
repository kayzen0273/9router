const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const { Sticker, StickerTypes } = require('wa-sticker-kit');
const { download: downloadTikTok } = require('@silent-tech-offc/ttdl');
const { ultraigdl } = require('ultra-igdl');

const app = express();
const PORT = process.env.PORT || 8080;

let qrData = null;
let connected = false;
let botSocket = null;
let pairingCode = null;
let pairingRequested = false;
let currentPhone = null;
const cache = new Map();

const server = app.listen(PORT, () => console.log("✅ Jalan di port " + PORT));
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Client konek");
  if (qrData) {
    qrcode.toDataURL(qrData).then(url => ws.send(JSON.stringify({ type: "qr", qr: url })));
  }
  if (pairingCode) ws.send(JSON.stringify({ type: "pairing", code: pairingCode }));
  if (connected) ws.send(JSON.stringify({ type: "connected" }));
});

function send(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ==================== ENDPOINTS ====================
app.get("/status", (req, res) => {
  res.json({ connected, qr: qrData ? "ada" : null, cache: cache.size, pairing: pairingCode });
});

app.get("/pair", async (req, res) => {
  if (!botSocket) return res.json({ error: "Bot belum siap" });
  if (botSocket.authState.creds.registered) return res.json({ error: "Udah terdaftar" });
  const phone = req.query.phone;
  if (!phone) return res.json({ error: "Kasih nomor: /pair?phone=62812..." });
  try {
    currentPhone = phone.replace(/\D/g, '');
    pairingRequested = false;
    const code = await botSocket.requestPairingCode(currentPhone);
    pairingCode = code;
    send({ type: "pairing", code });
    res.json({ code, phone: currentPhone });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get("/", (req, res) => res.send("Bot jalan! <a href='/status'>/status</a> | <a href='/pair?phone=62812...'>/pair</a>"));

// ==================== HELPER: DETEKSI VIEW ONCE ====================
function extractViewOnce(content) {
  let vo = content.viewOnceMessageV2 || content.viewOnceMessageV2Extension || content.viewOnceMessage;
  if (!vo && content.ephemeralMessage?.message) {
    vo = content.ephemeralMessage.message.viewOnceMessageV2 || 
         content.ephemeralMessage.message.viewOnceMessageV2Extension || 
         content.ephemeralMessage.message.viewOnceMessage;
  }
  return vo;
}

// ==================== HELPER: GET MEDIA DARI QUOTED ====================
async function getQuotedMedia(msg) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return null;
  
  if (quoted.imageMessage) return { type: 'image', message: quoted.imageMessage };
  if (quoted.videoMessage) return { type: 'video', message: quoted.videoMessage };
  if (quoted.stickerMessage) return { type: 'sticker', message: quoted.stickerMessage };
  
  return null;
}

// ==================== BOT ====================
async function start() {
  console.log("🚀 Start...");
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
  });

  botSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    console.log("📡 " + (connection || "-"));
    
    if (connection === "connecting" && !pairingRequested && !sock.authState.creds.registered && currentPhone) {
      pairingRequested = true;
      console.log("🔑 Minta pairing code...");
      try {
        await new Promise(r => setTimeout(r, 2000));
        const code = await sock.requestPairingCode(currentPhone);
        pairingCode = code;
        send({ type: "pairing", code });
        console.log("🔑 Code: " + code);
      } catch (e) {
        console.log("❌ Pair error:", e.message);
        pairingRequested = false;
      }
    }
    
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
      pairingCode = null;
      pairingRequested = false;
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
      console.log("📩 " + jid + " | " + text.substring(0, 50));

      // 🔥 DETEKSI VIEW ONCE (SIMPEN KE CACHE)
      const vo = extractViewOnce(content);
      if (vo && vo.message) {
        const inner = vo.message;
        const type = inner.imageMessage ? "image" : inner.videoMessage ? "video" : null;
        if (type) {
          cache.set(jid, { type, content: inner });
          console.log("📸 View once " + type + " DISIMPAN");
        }
      }

      // ==================== COMMAND .rvo ====================
      if (text.trim() === ".rvo") {
        const c = cache.get(jid);
        if (!c) {
          await sock.sendMessage(jid, { text: "❌ Gak ada view once" });
          continue;
        }
        try {
          const buf = await sock.downloadMediaMessage({ message: c.content });
          await sock.sendMessage(jid, { [c.type]: buf, caption: "🔓 .rvo — Diambil dari View Once" });
          cache.delete(jid);
          console.log("✅ .rvo terkirim");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Gagal: " + e.message });
        }
      }

      // ==================== COMMAND .sticker ====================
      if (text.trim() === ".sticker" || text.trim() === ".s") {
        const media = await getQuotedMedia(msg);
        if (!media) {
          await sock.sendMessage(jid, { text: "❌ Reply gambar/video dulu" });
          continue;
        }
        try {
          const buf = await sock.downloadMediaMessage({ message: media.message });
          const sticker = new Sticker(buf, {
            pack: 'WA RVO Bot',
            author: 'Owner',
            type: StickerTypes.FULL,
            quality: 80
          });
          const stickerBuffer = await sticker.toBuffer();
          await sock.sendMessage(jid, { sticker: stickerBuffer });
          console.log("✅ Sticker terkirim");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Gagal buat stiker: " + e.message });
        }
      }

      // ==================== COMMAND .tt (TikTok) ====================
      if (text.trim().startsWith(".tt ")) {
        const url = text.trim().replace(".tt ", "").trim();
        if (!url.includes("tiktok")) {
          await sock.sendMessage(jid, { text: "❌ Kasih link TikTok" });
          continue;
        }
        try {
          await sock.sendMessage(jid, { text: "⏳ Download TikTok..." });
          const v = await downloadTikTok(url);
          const videoUrl = v.videoNoWatermark || v.video;
          if (!videoUrl) {
            await sock.sendMessage(jid, { text: "❌ Gak bisa download" });
            continue;
          }
          await sock.sendMessage(jid, { video: { url: videoUrl }, caption: "🎵 " + (v.title || "TikTok") });
          console.log("✅ TikTok terkirim");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Error: " + e.message });
        }
      }

      // ==================== COMMAND .ig (Instagram) ====================
      if (text.trim().startsWith(".ig ")) {
        const url = text.trim().replace(".ig ", "").trim();
        if (!url.includes("instagram")) {
          await sock.sendMessage(jid, { text: "❌ Kasih link Instagram" });
          continue;
        }
        try {
          await sock.sendMessage(jid, { text: "⏳ Download Instagram..." });
          const ig = new ultraigdl();
          const result = await ig.download(url);
          
          if (result.code !== 200) {
            await sock.sendMessage(jid, { text: "❌ " + result.message });
            continue;
          }
          
          for (const item of result.media) {
            if (item.type === "video") {
              await sock.sendMessage(jid, { video: { url: item.url }, caption: "📷 " + (result.caption || "Instagram") });
            } else {
              await sock.sendMessage(jid, { image: { url: item.url }, caption: "📷 " + (result.caption || "Instagram") });
            }
          }
          console.log("✅ Instagram terkirim");
        } catch (e) {
          await sock.sendMessage(jid, { text: "❌ Error: " + e.message });
        }
      }
    }
  });
}

start();
