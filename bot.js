// bot.js — Pairing code version
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  Browsers 
} = require("@whiskeysockets/baileys");
const { WebSocketServer } = require("ws");
const express = require("express");
const pino = require("pino");

const app = express();
const PORT = process.env.PORT || 3000;

let pairingCode = null;
let isConnected = false;
let sock = null;
let currentNumber = null;

// WebSocket
const server = app.listen(PORT, () => console.log("Server jalan di " + PORT));
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// HTTP: Minta pairing code
app.get("/pair", async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: "Nomor wajib diisi" });

  // Format: 628xxx (tanpa +, spasi, strip)
  const cleanNumber = number.replace(/[^0-9]/g, '');
  if (cleanNumber.length < 10) {
    return res.status(400).json({ error: "Nomor gak valid" });
  }

  try {
    currentNumber = cleanNumber;
    const code = await generatePairingCode(cleanNumber);
    res.json({ code: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// HTTP: Cek status
app.get("/status", (req, res) => {
  res.json({ connected: isConnected, code: pairingCode });
});

async function generatePairingCode(phoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  
  // Hapus session lama kalo ada
  // (biar bisa pairing ulang)
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.macOS("Chrome"), // 🔥 WAJIB: format ini buat pairing code [citation:3]
  });

  sock.ev.on("creds.update", saveCreds);

  // Tunggu sampe socket siap, baru minta kode
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 30000);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr } = update;

      // 🔥 TRIGGER: Minta pairing code saat QR muncul [citation:10]
      if (qr && !sock.authState.creds.registered && !pairingCode) {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          pairingCode = code;
          clearTimeout(timeout);
          broadcast({ type: "pairing_code", code: code });
          resolve(code);
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      }

      if (connection === "open") {
        isConnected = true;
        broadcast({ type: "connected" });
        console.log("✅ WhatsApp terhubung!");
      }

      if (connection === "close") {
        isConnected = false;
        broadcast({ type: "disconnected" });
      }
    });
  });
}

// WebSocket
wss.on("connection", (ws) => {
  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.action === "pair" && data.number) {
        const code = await generatePairingCode(data.number);
        ws.send(JSON.stringify({ type: "pairing_code", code: code }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  });
});
