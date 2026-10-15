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

const PORT = process.env.BRIDGE_PORT || 3001;
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

// ----------------------------------------------------
// Blacklist / Ignored Numbers & Groups Configuration
// ----------------------------------------------------
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');

function getBlacklistConfig() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const data = fs.readFileSync(BLACKLIST_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading blacklist.json:', err.message);
  }
  return {
    ignore_all_groups: true,
    ignored_groups: [],
    ignored_numbers: []
  };
}

function cleanDigits(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

function isNumberIgnored(phone, ignoredNumbers = []) {
  if (!phone || !Array.isArray(ignoredNumbers)) return false;
  const cleanSender = cleanDigits(phone);
  if (!cleanSender) return false;

  return ignoredNumbers.some((num) => {
    const cleanBlocked = cleanDigits(num);
    if (!cleanBlocked) return false;
    // Exact match or suffix match (e.g. without or with country code)
    return cleanSender === cleanBlocked || 
      (cleanSender.length >= 7 && cleanBlocked.length >= 7 && (cleanSender.endsWith(cleanBlocked) || cleanBlocked.endsWith(cleanSender)));
  });
}

function isGroupIgnored(remoteJid, ignoredGroups = []) {
  if (!remoteJid || !Array.isArray(ignoredGroups)) return false;
  const cleanJid = String(remoteJid).toLowerCase().trim();

  return ignoredGroups.some((item) => {
    const cleanItem = String(item).toLowerCase().trim();
    if (!cleanItem) return false;
    return cleanJid.includes(cleanItem);
  });
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
      browser: Browsers.ubuntu('Chrome'),

      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
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
        console.log('[WhatsApp Web] Session logged out or link rejected. Clearing auth cache for fresh start...');
        const authDir = path.join(__dirname, 'auth_info_baileys');
        try {
          if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
          }
        } catch (_) {}
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

      // 🚫 STRICT RULE: NEVER reply or chat in WhatsApp groups!
      if (remoteJid.endsWith('@g.us') || remoteJid.includes('@g.us')) {
        continue;
      }

      // Don't reply to our own AI outbound messages
      if (msg.key.id && sentMessageIds.has(msg.key.id)) {
        continue;
      }


      // If fromMe is true: YOU sent a message on your phone!
      if (msg.key.fromMe) {
        let content = msg.message;
        if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
        if (content?.viewOnceMessage) content = content.viewOnceMessage.message;
        if (content?.viewOnceMessageV2) content = content.viewOnceMessageV2.message;

        const selfText = (
          content?.conversation || 
          content?.extendedTextMessage?.text || 
          ''
        ).trim().toLowerCase();

        // 1. Owner WhatsApp Commands (!status / !off / !on)
        if (selfText === '!status') {
          const isPaused = globalPauseAllUntil > Date.now();
          console.log(`[Owner Command] !status requested. Replying to ${remoteJid}`);
          logToFile(`[Owner Command] !status received. Replying...`);
          const replyText = isPaused 
            ? '⏸️ AI is currently PAUSED.' 
            : '🟢 AI (Meera) is currently ACTIVE and running 24/7 on Render! Group chats are BLOCKED.';
          const sent = await sock.sendMessage(remoteJid, { text: replyText });
          if (sent?.key?.id) sentMessageIds.add(sent.key.id);
          continue;
        }
        if (selfText === '!off' || selfText === '!pause') {
          globalPauseAllUntil = Date.now() + (60 * 60 * 1000); // 1 hour pause
          const sent = await sock.sendMessage(remoteJid, { text: '⏸️ AI auto-reply is now PAUSED globally for all chats.' });
          if (sent?.key?.id) sentMessageIds.add(sent.key.id);
          continue;
        }
        if (selfText === '!on' || selfText === '!resume') {
          globalPauseAllUntil = 0;
          humanActiveUntil.clear();
          const sent = await sock.sendMessage(remoteJid, { text: '▶️ AI auto-reply is now RESUMED globally!' });
          if (sent?.key?.id) sentMessageIds.add(sent.key.id);
          continue;
        }

        // 2. Check if this is self-chat ("Message yourself")
        const myLid = sock.user?.lid ? sock.user.lid.split(':')[0] : '';
        const isSelfChat = (cleanPhone && remoteJid.includes(cleanPhone)) || (myLid && remoteJid.includes(myLid));

        if (!isSelfChat) {
          // You sent a manual message to a contact: pause AI in this chat for 60s
          const pauseUntil = Date.now() + (CONVERSATION_PAUSE_SECONDS * 1000);
          humanActiveUntil.set(remoteJid, pauseUntil);
          const cleanRecipient = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
          console.log(`👤 [Human Active] You sent a message to +${cleanRecipient}. AI paused in this chat for ${CONVERSATION_PAUSE_SECONDS}s.`);
          logToFile(`[Human Active] Manual message to +${cleanRecipient}. Paused AI for ${CONVERSATION_PAUSE_SECONDS}s.`);
        }
        continue;
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

      // ----------------------------------------------------
      // Blacklist / Ignored Check (Groups & Specific Numbers)
      // ----------------------------------------------------
      const blacklist = getBlacklistConfig();

      // Check if group is ignored
      if (isGroup) {
        if (blacklist.ignore_all_groups) {
          console.log(`👥 [Group Ignored] AI auto-reply is disabled for groups. Skipping group chat: ${remoteJid}`);
          continue;
        }
        if (isGroupIgnored(remoteJid, blacklist.ignored_groups)) {
          console.log(`👥 [Group Ignored] Group ${remoteJid} is in blacklist. Skipping AI auto-reply.`);
          continue;
        }
      }

      // Check if phone number (or group participant) is blacklisted
      const participant = msg.key.participant ? msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '') : null;
      if (isNumberIgnored(senderPhone, blacklist.ignored_numbers) || (participant && isNumberIgnored(participant, blacklist.ignored_numbers))) {
        const blockedNumber = isNumberIgnored(senderPhone, blacklist.ignored_numbers) ? senderPhone : participant;
        console.log(`🚫 [Blacklist Active] Contact +${blockedNumber} is in blacklist. Skipping AI auto-reply.`);
        logToFile(`[Blacklist Active] Skipping AI auto-reply for +${blockedNumber}`);
        continue;
      }


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
          if (remoteJid.endsWith('@g.us') || remoteJid.includes('@g.us')) {
            console.log(`🚫 [Group Shield] Suppressed AI reply to group ${remoteJid}`);
            continue;
          }
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

app.get('/', (req, res) => {
  res.redirect('/qr');
});

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
  res.send(`<!DOCTYPE html><html><head><title>Link WhatsApp AI</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:24px 14px;background:#0b141a;color:#e9edef;">
    <div style="max-width:440px;margin:0 auto;background:#111b21;padding:24px 20px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
      <h2 style="color:#25D366;margin:0 0 4px;font-size:22px;">Link WhatsApp with Meera AI</h2>
      <p style="color:#8696a0;margin:0 0 18px;font-size:13px;">Choose either method below to connect your WhatsApp</p>

      <!-- Option 1: Pairing Code -->
      <div style="background:#1f2c34;padding:16px;border-radius:12px;margin-bottom:20px;text-align:left;">
        <h3 style="color:#25D366;margin:0 0 6px;font-size:15px;">⚡ Method 1: Link with Phone Number (Recommended)</h3>
        <p style="color:#8696a0;font-size:12px;margin:0 0 10px;line-height:1.4;">Enter your WhatsApp number (with country code, no +) to get an 8-character code:</p>
        <div style="display:flex;gap:8px;">
          <input type="tel" id="phoneInput" placeholder="e.g. 919000495107" style="flex:1;padding:10px 12px;border-radius:8px;border:1px solid #2a3942;background:#111b21;color:#fff;font-size:14px;outline:none;" />
          <button onclick="requestPairCode()" id="pairBtn" style="background:#25D366;color:#111b21;border:none;padding:10px 16px;border-radius:8px;font-weight:bold;cursor:pointer;font-size:13px;">Get Code</button>
        </div>
        <div id="codeDisplay" style="display:none;margin-top:14px;background:#111b21;padding:14px;border-radius:10px;text-align:center;border:1px solid #25D366;">
          <div style="font-size:11px;color:#8696a0;margin-bottom:4px;">ENTER THIS 8-DIGIT CODE IN WHATSAPP:</div>
          <div id="codeText" style="font-size:28px;font-weight:bold;letter-spacing:4px;color:#25D366;font-family:monospace;padding:6px 0;"></div>
          <p style="font-size:11px;color:#8696a0;margin:6px 0 0;line-height:1.4;">
            👉 In WhatsApp on phone: <b>Settings &gt; Linked Devices &gt; Link a Device &gt; Link with phone number instead</b>
          </p>
        </div>
        <div id="codeError" style="display:none;color:#f15c6d;font-size:12px;margin-top:10px;"></div>
      </div>

      <!-- Option 2: QR Code -->
      <div style="border-top:1px solid #202c33;padding-top:16px;">
        <h3 style="color:#8696a0;margin:0 0 12px;font-size:14px;">📷 Method 2: Scan QR Code</h3>
        <div style="background:#ffffff;display:inline-block;padding:12px;border-radius:12px;">
          <img src="${currentQRDataURL}" width="230" height="230" style="display:block;" />
        </div>
        <p style="color:#8696a0;font-size:11px;margin:12px 0 0;">WhatsApp &gt; Linked Devices &gt; Link a Device &gt; Scan QR</p>
      </div>

      <!-- Reset & Troubleshoot -->
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #202c33;">
        <p style="font-size:11px;color:#8696a0;margin:0 0 10px;">
          Seeing <i>"Could not connect"</i>? Log out old devices in WhatsApp first, then click:
        </p>
        <a href="/reset" style="background:#ea4335;color:#ffffff;text-decoration:none;padding:8px 16px;border-radius:8px;font-size:12px;display:inline-block;font-weight:600;">🔄 Reset Session & Refresh</a>
      </div>
    </div>

    <script>
      async function requestPairCode() {
        const phone = document.getElementById('phoneInput').value.trim();
        const errDiv = document.getElementById('codeError');
        const codeDiv = document.getElementById('codeDisplay');
        const codeText = document.getElementById('codeText');
        const btn = document.getElementById('pairBtn');

        errDiv.style.display = 'none';
        codeDiv.style.display = 'none';

        if (!phone) {
          errDiv.textContent = 'Please enter your phone number with country code (e.g. 919000495107)';
          errDiv.style.display = 'block';
          return;
        }

        btn.disabled = true;
        btn.textContent = 'Generating...';

        try {
          const res = await fetch('/pair-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phone })
          });
          const data = await res.json();
          if (data.code) {
            codeText.textContent = data.code;
            codeDiv.style.display = 'block';
          } else {
            errDiv.textContent = data.error || data.message || 'Could not generate code. Please try again.';
            errDiv.style.display = 'block';
          }
        } catch (err) {
          errDiv.textContent = 'Network error: ' + err.message;
          errDiv.style.display = 'block';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Get Code';
        }
      }

      setInterval(async () => {
        try {
          const r = await fetch('/status');
          const d = await r.json();
          if (d.connected) { location.reload(); }
        } catch (_) {}
      }, 2500);
    </script>
  </body></html>`);
});

app.post('/pair-code', async (req, res) => {
  try {
    let { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: 'Please enter your phone number with country code (e.g. 919000495107)' });
    }
    phone = String(phone).replace(/\D/g, '');
    if (!sock) {
      return res.status(503).json({ error: 'WhatsApp socket not ready. Please try again.' });
    }
    if (isConnected || sock.authState?.creds?.registered) {
      return res.json({ registered: true, message: 'WhatsApp is already connected!' });
    }
    const code = await sock.requestPairingCode(phone);
    console.log(`[Pairing Code] Generated code for +${phone}: ${code}`);
    return res.json({ success: true, code });
  } catch (err) {
    console.error('Error requesting pairing code:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/reset', async (req, res) => {
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
      } catch (_) {}
      sock = null;
    }
    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    isConnected = false;
    currentQR = null;
    currentQRDataURL = null;
    userPhone = null;
    console.log('[WhatsApp Web] Session reset requested. Re-initializing socket...');
    setTimeout(startWhatsAppSocket, 1000);
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2;url=/qr"><title>Resetting...</title></head><body style="background:#0b141a;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;">
      <h2 style="color:#25D366;">🔄 Session Cleared!</h2>
      <p style="color:#8696a0;">Generating fresh QR code now... Redirecting in 2 seconds.</p>
    </body></html>`);
  } catch (err) {
    return res.status(500).send(`Error resetting session: ${err.message}`);
  }
});



app.get('/logs', (req, res) => {
  try {
    const logPath = path.join(__dirname, 'bridge.log');
    if (fs.existsSync(logPath)) {
      return res.type('text/plain').send(fs.readFileSync(logPath, 'utf8'));
    }
    return res.type('text/plain').send('No logs yet.');
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

app.get('/blacklist', (req, res) => {

  res.json(getBlacklistConfig());
});

app.post('/blacklist', (req, res) => {
  try {
    const config = getBlacklistConfig();
    const { ignore_all_groups, ignored_groups, ignored_numbers } = req.body;
    if (typeof ignore_all_groups === 'boolean') config.ignore_all_groups = ignore_all_groups;
    if (Array.isArray(ignored_groups)) config.ignored_groups = ignored_groups;
    if (Array.isArray(ignored_numbers)) config.ignored_numbers = ignored_numbers;
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(config, null, 2), 'utf8');
    return res.json({ success: true, config });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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

  // Cloud Keep-Alive: Prevents Render free instances from going to sleep
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (externalUrl) {
    console.log(`[Cloud Keep-Alive] Initialized self-pinging every 10m for ${externalUrl}`);
    setInterval(async () => {
      try {
        await axios.get(`${externalUrl}/status`, { timeout: 10000 });
        console.log(`[Cloud Keep-Alive] Successfully pinged ${externalUrl}/status`);
      } catch (e) {
        console.log(`[Cloud Keep-Alive] Ping notice: ${e.message}`);
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }
});
