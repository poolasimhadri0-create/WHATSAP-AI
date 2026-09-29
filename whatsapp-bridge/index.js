import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import axios from 'axios';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://127.0.0.1:8000/api/v1/bridge/incoming';

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let currentQRDataURL = null;
let isConnected = false;
let userPhone = null;
const sentMessageIds = new Set();

// Smart Auto-Pause & Chat Takeover Settings
const humanActiveUntil = new Map();
let globalPauseAllUntil = 0;
let lastPhoneActionTime = 0;
const CONVERSATION_PAUSE_SECONDS = 60; // When you text in a chat, pause AI for 60s
const INCOMING_REPLY_DELAY_SECONDS = 5; // When away, AI replies in 5s

function logToFile(msg) {
  try {
    const logPath = path.join(__dirname, 'bridge.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
  } catch (_) {}
}

const logger = pino({ level: 'silent' });

let isStartingSocket = false;

async function startWhatsAppSocket() {
  if (isStartingSocket) return;
  isStartingSocket = true;

  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
      } catch (_) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.windows('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        return { conversation: '' };
      },
    });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      userPhone = null;

      try {
        currentQRDataURL = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Error creating QR data URL:', err);
      }

      console.log('\n======================================================');
      console.log('   SCAN THIS QR CODE IN WHATSAPP TO LINK YOUR AI AGENT');
      console.log('   (WhatsApp > Settings > Linked Devices > Link a Device)');
      console.log('======================================================\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n🔗 If ASCII QR is distorted in cloud logs, click or open this link to view QR code:');
      console.log(`https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(qr)}\n`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      currentQR = null;
      currentQRDataURL = null;
      console.log(`[WhatsApp Web] Connection closed due to: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);
      logToFile(`[Connection] Closed: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsAppSocket, 3000);
      } else {
        console.log('[WhatsApp Web] Session logged out. Ready for new QR scan.');
        setTimeout(startWhatsAppSocket, 1000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      currentQRDataURL = null;
      userPhone = sock.user?.id?.split(':')[0] || sock.user?.id || 'Connected';
      console.log('\n======================================================');
      console.log(`✅ WHATSAPP LINKED SUCCESSFULLY!`);
      console.log(`📱 Logged in as: +${userPhone}`);
      console.log(`🤖 Gemini AI is now actively responding to your WhatsApp chats!`);
      console.log('======================================================\n');
      logToFile(`[Connection] Open. Logged in as +${userPhone}`);
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    logToFile(`[messages.upsert] type=${m.type}, count=${m.messages?.length || 0}`);

    for (const msg of m.messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter')) continue;

      // Don't reply to our own AI outbound messages
      if (msg.key.id && sentMessageIds.has(msg.key.id)) {
        continue;
      }

      // Check if this is user messaging themselves ("Message yourself") or from external sender
      const cleanPhone = userPhone ? userPhone.replace('+', '').trim() : '';
      const isSelfChat = cleanPhone && remoteJid.includes(cleanPhone);

      // If fromMe is true: YOU sent a message on your phone!
      if (msg.key.fromMe) {
        if (isSelfChat) {
          // Self-chat commands: !off / !on / !status
          const selfText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
          if (selfText === '!off' || selfText === '!pause') {
            globalPauseAllUntil = Date.now() + (60 * 60 * 1000); // 1 hour global pause
            await sock.sendMessage(remoteJid, { text: '⏸️ AI auto-reply is now PAUSED globally for all chats.' });
            continue;
          }
          if (selfText === '!on' || selfText === '!resume') {
            globalPauseAllUntil = 0;
            humanActiveUntil.clear();
            await sock.sendMessage(remoteJid, { text: '▶️ AI auto-reply is now RESUMED globally!' });
            continue;
          }
          if (selfText === '!status') {
            const isPaused = globalPauseAllUntil > Date.now();
            await sock.sendMessage(remoteJid, { text: isPaused ? '⏸️ AI is currently PAUSED.' : '🟢 AI is currently ACTIVE.' });
            continue;
          }
        } else {
          // You sent a manual message to a contact from your phone!
          // Take over this chat: pause AI for this contact for 60 seconds
          const pauseUntil = Date.now() + (CONVERSATION_PAUSE_SECONDS * 1000);
          humanActiveUntil.set(remoteJid, pauseUntil);
          const cleanRecipient = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
          console.log(`👤 [Human Active] You sent a message to +${cleanRecipient}. AI paused in this chat for ${CONVERSATION_PAUSE_SECONDS}s.`);
          logToFile(`[Human Active] Manual message to +${cleanRecipient}. Paused AI for ${CONVERSATION_PAUSE_SECONDS}s.`);
          continue;
        }
      }

      // Unwrap nested messages (disappearing, view-once, quoted)
      let content = msg.message;
      if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
      if (content?.viewOnceMessage) content = content.viewOnceMessage.message;
      if (content?.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
      if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;

      // Extract text content
      const text =
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        content?.imageMessage?.caption ||
        content?.videoMessage?.caption ||
        '';

      if (!text.trim()) continue;

      const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
      const senderName = msg.pushName || (isSelfChat ? 'You' : 'WhatsApp User');
      const isGroup = remoteJid.endsWith('@g.us');

      // Manual command triggers in any chat
      const lowerCmd = text.toLowerCase().trim();
      if (lowerCmd === '!pause' || lowerCmd === '!ai off' || lowerCmd === '!off') {
        const pauseUntil = Date.now() + (30 * 60 * 1000); // 30 min manual pause
        humanActiveUntil.set(remoteJid, pauseUntil);
        console.log(`⏸️ AI manually paused for 30 minutes in chat ${remoteJid}`);
        await sock.sendMessage(remoteJid, { text: '⏸️ AI auto-reply paused in this chat.' });
        continue;
      }
      if (lowerCmd === '!resume' || lowerCmd === '!ai on' || lowerCmd === '!on') {
        humanActiveUntil.delete(remoteJid);
        console.log(`▶️ AI manually resumed in chat ${remoteJid}`);
        await sock.sendMessage(remoteJid, { text: '▶️ AI auto-reply resumed in this chat!' });
        continue;
      }

      // Global pause check
      if (globalPauseAllUntil > Date.now()) {
        console.log(`⏸️ [Global Pause Active] Skipping incoming message from +${senderPhone}.`);
        continue;
      }

      // Smart Chat Takeover: If human is actively chatting in this conversation
      let pausedUntil = humanActiveUntil.get(remoteJid);
      if (pausedUntil && Date.now() < pausedUntil && !isSelfChat) {
        const remainingSec = Math.ceil((pausedUntil - Date.now()) / 1000);
        console.log(`👤 [Human Active in Chat] You are actively chatting with +${senderPhone}. AI stopped (${remainingSec}s remaining).`);
        logToFile(`[Human Active in Chat] Skipping AI reply for +${senderPhone} (${remainingSec}s remaining).`);
        continue;
      } else if (pausedUntil && Date.now() >= pausedUntil) {
        humanActiveUntil.delete(remoteJid);
      }

      const logHeader = isGroup ? `[Group Inbound]` : (isSelfChat ? `[Self-Chat Inbound]` : `[WhatsApp Inbound]`);
      const logLine = `${logHeader} From +${senderPhone} (${senderName}): "${text}"`;
      console.log(`\n📥 ` + logLine);
      logToFile(logLine);

      try {
        // Send typing indicator (composing)
        try {
          await sock.sendPresenceUpdate('composing', remoteJid);
        } catch (_) {}

        // Forward message to FastAPI backend
        const res = await axios.post(FASTAPI_URL, {
          sender_phone: senderPhone,
          sender_name: senderName,
          message_text: text,
          message_id: msg.key.id,
        }, { timeout: 35000 });

        // CRITICAL RACE CONDITION CHECK:
        // Did the user send a message from their phone while Gemini was generating the reply?
        if (humanActiveUntil.get(remoteJid) > Date.now()) {
          console.log(`👤 [Cancelled AI reply] You sent a message while AI was generating. Suppressing AI reply to +${senderPhone}.`);
          logToFile(`[Cancelled AI reply] Human texted during AI generation. Suppressed reply to +${senderPhone}.`);
          await sock.sendPresenceUpdate('paused', remoteJid);
          continue;
        }

        // If AI produced a reply and handoff is not active, send it!
        if (res.data?.reply) {
          const aiReply = res.data.reply;
          console.log(`🤖 [Gemini AI Outbound] Replying to +${senderPhone}:\n"${aiReply}"\n`);
          logToFile(`[Outbound AI] Replying to +${senderPhone}: "${aiReply}"`);
          const sentResult = await sock.sendMessage(remoteJid, { text: aiReply });
          if (sentResult?.key?.id) {
            sentMessageIds.add(sentResult.key.id);
            if (sentMessageIds.size > 500) {
              const first = sentMessageIds.values().next().value;
              sentMessageIds.delete(first);
            }
          }
          await sock.sendPresenceUpdate('paused', remoteJid);
        } else if (res.data?.handoff) {
          console.log(`👤 [Handoff] Human takeover is active for +${senderPhone}. AI reply suppressed.`);
          logToFile(`[Handoff] Active for +${senderPhone}. AI reply suppressed.`);
        }
      } catch (err) {
        console.error(`❌ [Error] Failed to process message with AI backend: ${err.message}`);
        logToFile(`[Error] Failed to process message: ${err.message}`);
      }
    }
  });
  } catch (err) {
    console.error('Error in startWhatsAppSocket:', err);
    logToFile(`[Error] startWhatsAppSocket: ${err.message}`);
  } finally {
    isStartingSocket = false;
  }
}

// ----------------------------------------------------
// REST API Endpoints for Dashboard & Manual Agent Send
// ----------------------------------------------------

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    phone: userPhone,
    qr: currentQRDataURL,
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html><html><head><title>WhatsApp AI - Connected</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px 20px;background:#0b141a;color:#e9edef;">
      <div style="max-width:400px;margin:0 auto;background:#111b21;padding:30px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
        <div style="font-size:48px;margin-bottom:10px;">✅</div>
        <h2 style="color:#25D366;margin:0 0 10px;">WhatsApp Connected!</h2>
        <p style="font-size:18px;margin:5px 0;">Logged in as: <b>+${userPhone}</b></p>
        <p style="color:#8696a0;font-size:14px;margin-top:20px;">🤖 Gemini AI is now actively replying to your WhatsApp messages.</p>
      </div>
    </body></html>`);
  }
  if (!currentQRDataURL) {
    return res.send(`<!DOCTYPE html><html><head><title>Generating QR...</title><meta http-equiv="refresh" content="2"></head><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;background:#0b141a;color:#e9edef;">
      <h2>Generating WhatsApp QR Code...</h2>
      <p style="color:#8696a0;">Please wait a moment...</p>
    </body></html>`);
  }
  res.send(`<!DOCTYPE html><html><head><title>Scan WhatsApp QR Code</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#0b141a;color:#e9edef;">
    <div style="max-width:420px;margin:0 auto;background:#111b21;padding:30px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
      <h2 style="color:#25D366;margin:0 0 8px;">Scan with WhatsApp</h2>
      <p style="color:#8696a0;margin:0 0 20px;font-size:14px;">WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device</p>
      <div style="background:#ffffff;display:inline-block;padding:16px;border-radius:12px;">
        <img src="${currentQRDataURL}" width="300" height="300" style="display:block;" />
      </div>
      <p style="color:#8696a0;font-size:13px;margin-top:20px;">This page automatically updates when connected.</p>
    </div>
    <script>
      setInterval(async () => {
        try {
          const r = await fetch('/status');
          const d = await r.json();
          if (d.connected) { location.reload(); }
        } catch (_) {}
      }, 2000);
    </script>
  </body></html>`);
});

app.post('/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!sock || !isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected. Please scan QR code first.' });
  }

  const cleanPhone = phone.replace('+', '').trim();
  const jid = `${cleanPhone}@s.whatsapp.net`;

  try {
    const result = await sock.sendMessage(jid, { text });
    console.log(`[Agent Manual Outbound] Sent to +${cleanPhone}: "${text}"`);
    return res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    console.error(`Failed to send manual WhatsApp message: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    isConnected = false;
    currentQR = null;
    currentQRDataURL = null;
    userPhone = null;
    return res.json({ success: true, message: 'Logged out. Ready for new QR scan.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[WhatsApp Web Bridge Server] Listening on http://localhost:${PORT}`);
  startWhatsAppSocket();
});
