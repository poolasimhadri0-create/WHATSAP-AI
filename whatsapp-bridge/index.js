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
const FASTAPI_URL = process.env.FASTAPI_URL || `http://127.0.0.1:${process.env.BACKEND_PORT || process.env.SERVER_PORT || (process.env.BRIDGE_PORT === process.env.PORT ? 8000 : process.env.PORT) || 8000}/api/v1/bridge/incoming`;

const app = express();
app.use(cors());
app.use(express.json());

process.on('uncaughtException', (err) => {
  console.error('[Bridge UncaughtException]:', err.message || err);
  logToFile(`[UncaughtException] ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Bridge UnhandledRejection]:', reason);
  logToFile(`[UnhandledRejection] ${reason}`);
});

import NodeCache from '@cacheable/node-cache';

let sock = null;
let currentQR = null;
let currentQRDataURL = null;
let isConnected = false;
let userPhone = null;
const sentMessageIds = new Set();
const humanActiveUntil = new Map();
const pendingReplyTimers = new Map();
let lastOwnerActiveTime = 0;
let isOwnerOnline = false;

// 🛡️ E2EE Message Store & Retry Cache to prevent "Waiting for this message" error
const msgRetryCounterCache = new NodeCache();
const messageStore = new Map();
const MAX_SAVED_MESSAGES = 3000;

function saveToMessageStore(id, message) {
  if (!id || !message) return;
  messageStore.set(id, message);
  if (messageStore.size > MAX_SAVED_MESSAGES) {
    const oldestKey = messageStore.keys().next().value;
    messageStore.delete(oldestKey);
  }
}

async function sendSafeMessage(jid, content, options = {}) {
  if (!sock) return null;
  try {
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      if (sentMessageIds.size > 500) {
        const first = sentMessageIds.values().next().value;
        sentMessageIds.delete(first);
      }
      if (sent.message) {
        saveToMessageStore(sent.key.id, sent.message);
      }
    }
    return sent;
  } catch (err) {
    console.error(`❌ [SendMessage Error] Failed sending to ${jid}:`, err.message);
    logToFile(`[SendMessage Error] ${jid}: ${err.message}`);
    throw err;
  }
}

// -------------------------------------------------------------------
// TIMING & AUTO-REPLY RULES:
// 1. When owner is active/online in WhatsApp -> Meera stops immediately!
// 2. When owner is online -> Meera does NOT reply to user messages!
// 3. When owner goes offline -> 16-second countdown begins!
//    After 16 seconds of owner inactivity, Meera comes online to reply.
// 4. In WhatsApp groups -> Meera NEVER responds or replies if a link is present!
// 5. When owner texts a contact -> Meera stops in that chat for 5 mins.
// -------------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function getSettings() {
  const defaults = {
    isAiPaused: false,
    pauseUntil: 0,
    inboundWaitSeconds: 0,        // Instant reply when owner is offline (no wait)
    ownerInactivitySeconds: 15,   // 15 seconds idle fallback (auto-activates quickly after owner closes WhatsApp)
    chatTakeoverMinutes: 1,       // When owner texts someone, Meera stops in that chat for 1 min
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...defaults, ...data };
    }
  } catch (_) {}
  return defaults;
}

function saveSettings(newSettings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving settings.json:', err.message);
  }
}

let bridgeSettings = getSettings();

function cleanDigits(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

function isOwnerJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (jid.endsWith('@g.us') || jid.includes('@g.us')) return false;
  if (jid.includes('@newsletter') || jid.includes('@broadcast')) return false;

  const rawId = jid.split('@')[0].split(':')[0];
  const cleanId = cleanDigits(rawId);
  const cleanOwner = cleanDigits(userPhone);

  if (cleanOwner && cleanId === cleanOwner) return true;

  if (sock?.user?.id) {
    const sockUserDigits = cleanDigits(sock.user.id.split('@')[0].split(':')[0]);
    if (sockUserDigits && cleanId === sockUserDigits) return true;
  }

  if (sock?.user?.lid) {
    const sockLidDigits = cleanDigits(sock.user.lid.split('@')[0].split(':')[0]);
    if (sockLidDigits && cleanId === sockLidDigits) return true;
  }

  return false;
}

function isSelfChat(remoteJid) {
  if (!remoteJid) return false;
  const cleanOwnerPhone = cleanDigits(userPhone);
  const myLid = sock?.user?.lid ? sock.user.lid.split(':')[0] : '';
  return Boolean(
    (cleanOwnerPhone && remoteJid.includes(cleanOwnerPhone)) ||
    (myLid && remoteJid.includes(myLid))
  );
}

// 🛡️ Strict URL / Link Detection Helper
function containsLink(text, msgContent = null) {
  if (msgContent) {
    if (msgContent.extendedTextMessage?.matchedText || msgContent.extendedTextMessage?.canonicalUrl) {
      return true;
    }
    if (msgContent.groupInviteMessage) {
      return true;
    }
  }
  if (!text || typeof text !== 'string') return false;

  // Regex matches http://, https://, www., domain.ext/, chat.whatsapp.com, wa.me, t.me, etc.
  const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?)|(chat\.whatsapp\.com\/[^\s]+)|(wa\.me\/[^\s]+)|(t\.me\/[^\s]+)/i;
  return urlPattern.test(text);
}

function handleOwnerActivityDetected(source, targetJid = null) {
  lastOwnerActiveTime = Date.now();
  isOwnerOnline = true;
  console.log(`👤 [Owner Active in WhatsApp] ${source}! Meera AI stopped immediately.`);
  logToFile(`[Owner Active] ${source}. Target: ${targetJid || 'global'}`);

  // Cancel ALL pending AI reply timers immediately!
  if (pendingReplyTimers.size > 0) {
    for (const [jid, item] of pendingReplyTimers.entries()) {
      clearTimeout(item.timeoutId);
      const cleanPhone = cleanDigits(jid);
      console.log(`🛑 [Cancelled AI Reply] Owner opened WhatsApp / became active (${source}). Cancelled pending reply for +${cleanPhone}.`);
      logToFile(`[Cancelled AI Reply] Cancelled pending reply for +${cleanPhone} due to: ${source}`);
    }
    pendingReplyTimers.clear();
  }

  // If a specific conversation was interacted with, activate human takeover
  if (targetJid && !isSelfChat(targetJid)) {
    const takeoverMs = (bridgeSettings.chatTakeoverMinutes || 1) * 60 * 1000;
    humanActiveUntil.set(targetJid, Date.now() + takeoverMs);
  }
}

function handleOwnerOfflineDetected(source) {
  if (isOwnerOnline) {
    isOwnerOnline = false;
    lastOwnerActiveTime = Date.now();
    console.log(`👤 [Owner Offline] ${source}. You closed WhatsApp. Meera AI will now reply to messages.`);
    logToFile(`[Owner Offline] ${source}. Owner closed WhatsApp. Meera AI activated.`);
  }
}

function getOwnerInactivityRemainingSeconds() {
  if (lastOwnerActiveTime <= 0) return 0;
  const elapsed = Date.now() - lastOwnerActiveTime;
  const requiredMs = (bridgeSettings.ownerInactivitySeconds || 15) * 1000;
  if (elapsed >= requiredMs) return 0;
  return Math.ceil((requiredMs - elapsed) / 1000);
}

function getAiOperationalStatus() {
  // 1. Manual Pause Override
  if (bridgeSettings.isAiPaused) {
    if (bridgeSettings.pauseUntil > 0) {
      if (Date.now() < bridgeSettings.pauseUntil) {
        const remainingMs = bridgeSettings.pauseUntil - Date.now();
        return {
          status: 'paused',
          reason: 'manual_pause',
          description: `AI manually paused (${Math.ceil(remainingMs / 60000)}m left)`,
          remainingMs,
          remainingSec: Math.ceil(remainingMs / 1000),
        };
      } else {
        bridgeSettings.isAiPaused = false;
        bridgeSettings.pauseUntil = 0;
        saveSettings(bridgeSettings);
      }
    } else {
      return {
        status: 'stopped',
        reason: 'indefinite_stop',
        description: 'AI is stopped manually (Send !on or click Resume to start)',
        remainingMs: Infinity,
        remainingSec: Infinity,
      };
    }
  }

  // 2. Owner Online / Active Check:
  const idleTimeoutMs = (bridgeSettings.ownerInactivitySeconds || 15) * 1000;
  const timeSinceActive = lastOwnerActiveTime > 0 ? (Date.now() - lastOwnerActiveTime) : Infinity;

  // Auto-expire only if owner has been completely inactive for 15 seconds
  if (timeSinceActive >= idleTimeoutMs) {
    isOwnerOnline = false;
  }

  if (isOwnerOnline) {
    return {
      status: 'owner_active',
      reason: 'owner_in_whatsapp',
      description: '👤 You are ONLINE in WhatsApp! Meera AI is STOPPED (No replies while you are in WhatsApp).',
      remainingMs: Infinity,
      remainingSec: Infinity,
    };
  }

  return {
    status: 'active',
    reason: 'running',
    description: '🟢 Meera AI is ACTIVE! (You closed WhatsApp, so Meera is auto-replying)',
    remainingMs: 0,
    remainingSec: 0,
  };
}

function logToFile(msg) {
  try {
    const logPath = path.join(__dirname, 'bridge.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${msg}\n`);
  } catch (_) {}
}

function clearAuthDirectory() {
  const authDir = path.join(__dirname, 'auth_info_baileys');
  try {
    if (fs.existsSync(authDir)) {
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        try {
          fs.rmSync(path.join(authDir, file), { recursive: true, force: true });
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('Error clearing auth directory contents:', err.message);
  }
}

function isSessionCorruptedOrUnregistered() {
  const credsPath = path.join(__dirname, 'auth_info_baileys', 'creds.json');
  try {
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.registered === false) {
        return true;
      }
    }
  } catch (_) {
    return true;
  }
  return false;
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

function isNumberIgnored(phone, ignoredNumbers = []) {
  if (!phone || !Array.isArray(ignoredNumbers)) return false;
  const cleanSender = cleanDigits(phone);
  if (!cleanSender) return false;

  return ignoredNumbers.some((num) => {
    const cleanBlocked = cleanDigits(num);
    if (!cleanBlocked) return false;
    return cleanSender === cleanBlocked || 
      (cleanSender.length >= 7 && cleanBlocked.length >= 7 && (cleanSender.endsWith(cleanBlocked) || cleanBlocked.endsWith(cleanSender)));
  });
}

const logger = pino({ level: 'silent' });
let isStartingSocket = false;

async function subscribeOwnerPresence() {
  if (!sock || !isConnected || !userPhone) return;
  try {
    const cleanPhone = cleanDigits(userPhone);
    const ownerJid = `${cleanPhone}@s.whatsapp.net`;
    await sock.presenceSubscribe(ownerJid);
    if (sock.user?.lid) {
      await sock.presenceSubscribe(sock.user.lid);
    }
  } catch (_) {}
}

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
      msgRetryCounterCache,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      getMessage: async (key) => {
        if (key?.id && messageStore.has(key.id)) {
          return messageStore.get(key.id);
        }
        return undefined; // Must return undefined so Baileys does not corrupt the retry
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
        console.log('\n🔗 Open http://localhost:3001/qr in your browser to view QR or Link with Phone Number\n');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
        isConnected = false;
        currentQR = null;
        currentQRDataURL = null;

        const errMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'Unknown disconnect');
        console.log(`[WhatsApp Web] Connection closed due to: ${errMsg} (statusCode=${statusCode})`);
        logToFile(`[Connection] Closed: ${errMsg}, statusCode=${statusCode}`);

        if (isLoggedOut) {
          console.log('[WhatsApp Web] Session logged out. Clearing auth cache...');
          clearAuthDirectory();
          setTimeout(startWhatsAppSocket, 1500);
        } else if (isRestartRequired) {
          console.log('[WhatsApp Web] Handshake accepted! Restarting socket to finalize pairing...');
          setTimeout(startWhatsAppSocket, 800);
        } else {
          console.log('[WhatsApp Web] Temporary disconnect. Retrying connection in 3 seconds...');
          setTimeout(startWhatsAppSocket, 3000);
        }
      } else if (connection === 'open') {
        isConnected = true;
        currentQR = null;
        currentQRDataURL = null;
        userPhone = sock.user?.id?.split(':')[0] || sock.user?.id || 'Connected';
        console.log('\n======================================================');
        console.log(`✅ WHATSAPP LINKED SUCCESSFULLY!`);
        console.log(`📱 Logged in as: +${userPhone}`);
        console.log(`🤖 Meera AI Timing Plan Active:`);
        console.log(`   - When you are online/active in WhatsApp: Meera stops immediately!`);
        console.log(`   - When you message someone: Meera stops in that chat for 5 mins!`);
        console.log(`   - When you close WhatsApp: Meera auto-activates!`);
        console.log('======================================================\n');
        logToFile(`[Connection] Open. Logged in as +${userPhone}`);
        subscribeOwnerPresence();
      }
    });

    // ----------------------------------------------------
    // 1. Detect Real-Time Owner Activity & Presence Updates
    // ----------------------------------------------------
    // A. Raw WebSocket Receipt Stanzas (Owner reading on phone)
    sock.ws?.on('CB:receipt', (node) => {
      try {
        const attrs = node?.attrs || {};
        const chatJid = attrs.from || attrs.recipient || attrs.to || '';
        if (chatJid.includes('@newsletter') || chatJid.includes('@broadcast') || chatJid.includes('@g.us')) {
          return; // Ignore newsletter / broadcast / group receipts
        }
        const type = attrs.type;
        if (type === 'read-self' || type === 'played-self') {
          handleOwnerActivityDetected(`Owner read chat on phone (${type})`, chatJid);
        } else if ((type === 'read' || type === 'played') && isOwnerJid(attrs.from)) {
          handleOwnerActivityDetected(`Owner read chat on phone (${type})`, chatJid);
        }
      } catch (_) {}
    });

    // B. Raw Chatstate Stanzas (Owner typing on phone)
    sock.ws?.on('CB:chatstate', (node) => {
      try {
        const attrs = node?.attrs || {};
        if (isOwnerJid(attrs.from) || isOwnerJid(attrs.participant)) {
          handleOwnerActivityDetected('Owner typing on phone', attrs.from);
        }
      } catch (_) {}
    });

    // C. Raw Presence Stanzas (Owner online or offline)
    sock.ws?.on('CB:presence', (node) => {
      try {
        const attrs = node?.attrs || {};
        const from = attrs.from || '';
        if (isOwnerJid(from)) {
          const type = attrs.type;
          if (type === 'unavailable') {
            handleOwnerOfflineDetected('Presence unavailable stanza');
          } else {
            handleOwnerActivityDetected(`Presence online stanza (${type || 'available'})`, from);
          }
        }
      } catch (_) {}
    });


    // E. Baileys messages.update (Status 4 = READ, Status 5 = PLAYED)
    sock.ev.on('messages.update', (updates) => {
      try {
        for (const u of updates) {
          const status = u.update?.status;
          if ((status === 4 || status === 5) && !u.key?.fromMe) {
            handleOwnerActivityDetected('Incoming message marked READ on phone', u.key?.remoteJid);
          }
        }
      } catch (_) {}
    });

    // F. Baileys message-receipt.update
    sock.ev.on('message-receipt.update', (events) => {
      try {
        for (const e of events) {
          if (e.receipt?.readTimestamp && !e.key?.fromMe) {
            handleOwnerActivityDetected('Read receipt detected on phone', e.key?.remoteJid);
          }
        }
      } catch (_) {}
    });

    // G. Baileys chats.update (Unread count becomes 0 when owner opens a chat)
    sock.ev.on('chats.update', (chats) => {
      try {
        for (const chat of chats) {
          if (typeof chat.unreadCount === 'number' && chat.unreadCount === 0) {
            handleOwnerActivityDetected('Owner opened chat in WhatsApp', chat.id);
          }
        }
      } catch (_) {}
    });

    // H. Standard Presence Updates
    sock.ev.on('presence.update', (update) => {
      const { id, presences } = update || {};
      let matchedPresence = null;

      if (isOwnerJid(id)) {
        for (const p of Object.values(presences || {})) {
          matchedPresence = p;
          break;
        }
      } else if (presences) {
        for (const [pjid, p] of Object.entries(presences)) {
          if (isOwnerJid(pjid)) {
            matchedPresence = p;
            break;
          }
        }
      }

      if (matchedPresence) {
        const pStatus = matchedPresence.lastKnownPresence;
        if (pStatus === 'available' || pStatus === 'composing' || pStatus === 'recording') {
          handleOwnerActivityDetected(`Presence ONLINE (${pStatus})`, id);
        } else if (pStatus === 'unavailable' || pStatus === 'paused') {
          handleOwnerOfflineDetected(`Presence OFFLINE (${pStatus})`);
        }
      }
    });

    // ----------------------------------------------------
    // 2. Process Incoming & Outgoing Messages
    // ----------------------------------------------------
    sock.ev.on('messages.upsert', async (m) => {
      logToFile(`[messages.upsert] type=${m.type}, count=${m.messages?.length || 0}`);

      for (const msg of m.messages) {
        if (!msg.message) continue;
        if (msg.key?.id) {
          saveToMessageStore(msg.key.id, msg.message);
        }
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter')) continue;

        let content = msg.message;
        if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
        if (content?.viewOnceMessage) content = content.viewOnceMessage.message;
        if (content?.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
        if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;

        const text =
          content?.conversation ||
          content?.extendedTextMessage?.text ||
          content?.imageMessage?.caption ||
          content?.videoMessage?.caption ||
          '';

        // 🚫 GROUP CHAT & GROUP LINK PROTECTION:
        // User rule: When links arrive in groups, Meera AI must NOT respond and must NOT reply!
        const isGroupMessage = remoteJid.endsWith('@g.us') || 
                               remoteJid.includes('@g.us') || 
                               Boolean(msg.key.participant) || 
                               Boolean(msg.participant);

        if (isGroupMessage) {
          if (containsLink(text, content)) {
            console.log(`🚫 [Group Link Blocked] Link detected in group chat (${remoteJid}). Meera AI will NOT respond or reply.`);
            logToFile(`[Group Link Blocked] Suppressed reply for link in group (${remoteJid}): "${text}"`);
            continue; // Do NOT respond, do NOT reply!
          }

          // Check if all groups are ignored
          const blacklist = getBlacklistConfig();
          if (blacklist.ignore_all_groups !== false) {
            continue;
          }
        }

        // Ignore messages sent by our AI bot
        if (msg.key.id && sentMessageIds.has(msg.key.id)) {
          continue;
        }

        const isSelf = isSelfChat(remoteJid);

        // ====================================================
        // 👤 OWNER SENT A MESSAGE (from phone or WhatsApp Web)
        // ====================================================
        if (msg.key.fromMe) {
          handleOwnerActivityDetected('Owner sent message', remoteJid);

          const selfText = (
            content?.conversation || 
            content?.extendedTextMessage?.text || 
            ''
          ).trim().toLowerCase();

          // WhatsApp Remote Commands (Send in self-chat)
          if (selfText === '!off' || selfText === '!stop' || selfText === 'stop' || selfText === 'turn off ai') {
            bridgeSettings.isAiPaused = true;
            bridgeSettings.pauseUntil = 0;
            saveSettings(bridgeSettings);
            console.log(`🛑 [AI Stopped] Owner sent command "${selfText}". Meera AI is now STOPPED.`);
            logToFile(`[AI Stopped] Owner sent command "${selfText}".`);
            const reply = '🛑 *Meera AI is now STOPPED.*\n\nAI will NOT reply to any messages.\n\nSend *!on* or *start* anytime to resume.';
            await sendSafeMessage(remoteJid, { text: reply });
            continue;
          }

          if (selfText === '!on' || selfText === '!start' || selfText === 'start' || selfText === 'turn on ai') {
            bridgeSettings.isAiPaused = false;
            bridgeSettings.pauseUntil = 0;
            lastOwnerActiveTime = 0;
            isOwnerOnline = false;
            humanActiveUntil.clear();
            saveSettings(bridgeSettings);
            console.log(`▶️ [AI Resumed] Owner sent command "${selfText}". Meera AI is now ACTIVE.`);
            logToFile(`[AI Resumed] Owner sent command "${selfText}".`);
            const reply = '▶️ *Meera AI is now ACTIVE!*\n\nAI will automatically reply when you are offline for 16s, and stops immediately whenever you are active on WhatsApp.';
            await sendSafeMessage(remoteJid, { text: reply });
            continue;
          }

          if (selfText === '!status') {
            const opStatus = getAiOperationalStatus();
            let statusText = '';
            if (bridgeSettings.isAiPaused) {
              statusText = '🛑 *Meera AI is currently STOPPED manually*.\n\nSend *!on* or *start* to activate.';
            } else if (isOwnerOnline) {
              statusText = '👤 *Meera AI is STOPPED because you are online in WhatsApp*.\n\nMeera will NOT reply while you are in WhatsApp. When you close WhatsApp, Meera will activate.';
            } else {
              statusText = '🟢 *Meera AI is ACTIVE & READY*.\n\nShe auto-replies when you close WhatsApp. Whenever you open WhatsApp, she stops immediately!';
            }
            await sendSafeMessage(remoteJid, { text: statusText });
            continue;
          }

          // 🛡️ CHAT TAKEOVER: You sent a message to a contact!
          // Protect this conversation from Meera for 5 minutes!
          if (!isSelf) {
            const takeoverMs = (bridgeSettings.chatTakeoverMinutes || 1) * 60 * 1000;
            humanActiveUntil.set(remoteJid, Date.now() + takeoverMs);
            const cleanRecipient = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
            console.log(`👤 [Owner in WhatsApp] You sent a message to +${cleanRecipient}. Meera AI stopped in this chat for ${bridgeSettings.chatTakeoverMinutes || 1}m!`);
            logToFile(`[Owner Active] Sent message to +${cleanRecipient}. AI stopped in this chat.`);
          }
          continue;
        }

        // ====================================================
        // 📥 INCOMING MESSAGE FROM ANOTHER CONTACT
        // ====================================================
        // Check if message was already marked read on open chat screen
        if (msg.status === 4 || msg.status === 5) {
          handleOwnerActivityDetected('Incoming message already read on open chat', remoteJid);
          continue;
        }

        if (!text.trim()) continue;

        const senderPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
        const senderName = msg.pushName || (isSelf ? 'You' : 'WhatsApp User');

        // Self-chat protection: ignore personal notes unless prefixed with !ai or !meera
        if (isSelf) {
          const lowerSelf = text.trim().toLowerCase();
          const isExplicitAi = lowerSelf.startsWith('!ai ') || lowerSelf.startsWith('!meera ');
          if (!isExplicitAi) {
            continue;
          }
        }

        // Check blacklist
        const blacklist = getBlacklistConfig();
        const participant = msg.key.participant ? msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '') : null;
        if (isNumberIgnored(senderPhone, blacklist.ignored_numbers) || (participant && isNumberIgnored(participant, blacklist.ignored_numbers))) {
          const blockedNumber = isNumberIgnored(senderPhone, blacklist.ignored_numbers) ? senderPhone : participant;
          console.log(`🚫 [Blacklist Active] Contact +${blockedNumber} is in blacklist. Skipping AI auto-reply.`);
          continue;
        }

        // Manual pause check
        if (bridgeSettings.isAiPaused) {
          console.log(`🛑 [AI Stopped] Meera is paused manually. Skipping message from +${senderPhone}.`);
          continue;
        }

        // 1. CHAT TAKEOVER CHECK: Are you chatting with this specific person?
        const takeoverUntil = humanActiveUntil.get(remoteJid);
        if (takeoverUntil && Date.now() < takeoverUntil && !isSelf) {
          const remainingMin = Math.ceil((takeoverUntil - Date.now()) / 60000);
          console.log(`👤 [Human Conversation Active] You are chatting with +${senderPhone}. Meera AI stopped in this chat (${remainingMin}m remaining).`);
          logToFile(`[Human Conversation] Suppressed AI reply for +${senderPhone}. Owner active in chat.`);
          continue;
        }

        // 2. OWNER ONLINE CHECK:
        const timeSinceOwnerActive = lastOwnerActiveTime > 0 ? (Date.now() - lastOwnerActiveTime) : Infinity;
        const idleTimeoutMs = (bridgeSettings.ownerInactivitySeconds || 15) * 1000;

        // Auto-expire only if owner has been completely inactive for 15 seconds
        if (timeSinceOwnerActive >= idleTimeoutMs) {
          isOwnerOnline = false;
        }

        // When owner is online in WhatsApp: Strictly NO AI reply!
        if (isOwnerOnline && !isSelf) {
          console.log(`👤 [Owner Online in WhatsApp] You are currently online in WhatsApp. Meera AI will NOT reply to message from +${senderPhone}.`);
          logToFile(`[Owner Online] Suppressed AI reply for +${senderPhone}. Owner is online in WhatsApp.`);
          continue; // Strictly NO reply!
        }

        // 3. INBOUND BUFFER (0s = Instant reply when offline):
        const waitTimeMs = (bridgeSettings.inboundWaitSeconds || 0) * 1000;
        if (waitTimeMs > 0) {
          console.log(`⏳ [Inbound Buffer] Message received from +${senderPhone}. Waiting ${Math.ceil(waitTimeMs / 1000)}s buffer... If you open WhatsApp, AI reply will cancel.`);
        } else {
          console.log(`⚡ [Meera Instant] Owner offline. Replying instantly to +${senderPhone}...`);
        }

        const waitSecDisplay = Math.ceil(waitTimeMs / 1000);
        const logHeader = isSelf ? `[Self-Chat Inbound]` : `[WhatsApp Inbound]`;
        const logLine = `${logHeader} From +${senderPhone} (${senderName}): "${text}" (Buffer: ${waitSecDisplay}s)`;
        console.log(`\n📥 ` + logLine);
        logToFile(logLine);

        // Cancel any existing pending timer for this conversation
        if (pendingReplyTimers.has(remoteJid)) {
          clearTimeout(pendingReplyTimers.get(remoteJid).timeoutId);
          pendingReplyTimers.delete(remoteJid);
        }

        const msgSnapshot = msg;
        const capturedRemoteJid = remoteJid;
        const capturedSenderPhone = senderPhone;
        const capturedSenderName = senderName;
        const capturedText = text;

        const timeoutId = setTimeout(async () => {
          pendingReplyTimers.delete(capturedRemoteJid);

          // Post-wait check 1: Was AI paused manually?
          if (bridgeSettings.isAiPaused) {
            console.log(`🛑 [Cancelled AI Reply] Meera was stopped manually. Suppressed reply for +${capturedSenderPhone}.`);
            return;
          }

          // Post-wait check 2: Did owner text this contact during the wait?
          const checkTakeover = humanActiveUntil.get(capturedRemoteJid);
          if (checkTakeover && Date.now() < checkTakeover) {
            console.log(`👤 [Human Conversation Active] Owner chatted with +${capturedSenderPhone}. Suppressed AI reply.`);
            return;
          }

          // Post-wait check 3: Did owner open WhatsApp or become online during the wait?
          if (isOwnerOnline) {
            console.log(`👤 [Cancelled AI Reply] Owner is online in WhatsApp. Suppressed AI reply for +${capturedSenderPhone}.`);
            logToFile(`[Cancelled AI Reply] Suppressed reply for +${capturedSenderPhone}. Owner became online.`);
            return;
          }

          // 🟢 OWNER IS OFFLINE: Meera Auto-Activates to help the contact!
          console.log(`⚡ [Meera Auto-Activated] Generating instant AI reply for +${capturedSenderPhone} (${capturedSenderName})...`);
          logToFile(`[Meera Auto-Activated] Generating reply for +${capturedSenderPhone}`);

          try {
            // Non-blocking composing presence so it doesn't add latency to the AI call
            sock.sendPresenceUpdate('composing', capturedRemoteJid).catch(() => {});

            // Forward message to FastAPI backend immediately
            const res = await axios.post(FASTAPI_URL, {
              sender_phone: capturedSenderPhone,
              sender_name: capturedSenderName,
              message_text: capturedText,
              message_id: msgSnapshot.key.id,
            }, { timeout: 35000 });

            // CRITICAL RACE CONDITION CHECK:
            // Did the owner open WhatsApp, read the chat, or send a message while Gemini was generating the reply?
            const finalTakeover = humanActiveUntil.get(capturedRemoteJid);
            if (isOwnerOnline || (finalTakeover && Date.now() < finalTakeover) || bridgeSettings.isAiPaused) {
              console.log(`👤 [Cancelled AI reply] Owner became active in WhatsApp while AI was generating. Suppressing reply to +${capturedSenderPhone}.`);
              logToFile(`[Cancelled AI reply] Suppressed reply to +${capturedSenderPhone}. Owner became active.`);
              try { await sock.sendPresenceUpdate('paused', capturedRemoteJid); } catch (_) {}
              return;
            }

            if (res.data?.reply) {
              if (capturedRemoteJid.endsWith('@g.us') || capturedRemoteJid.includes('@g.us')) {
                return;
              }
              const aiReply = res.data.reply;
              console.log(`🤖 [Meera AI Outbound] Replying to +${capturedSenderPhone}:\n"${aiReply}"\n`);
              logToFile(`[Outbound AI] Replying to +${capturedSenderPhone}: "${aiReply}"`);
              await sendSafeMessage(capturedRemoteJid, { text: aiReply });
              try { await sock.sendPresenceUpdate('paused', capturedRemoteJid); } catch (_) {}
            } else if (res.data?.handoff) {
              console.log(`👤 [Handoff] Human takeover active for +${capturedSenderPhone}. AI reply suppressed.`);
              logToFile(`[Handoff] Active for +${capturedSenderPhone}. AI reply suppressed.`);
            }
          } catch (err) {
            console.error(`❌ [Error] Failed to process message with AI backend: ${err.message}`);
            logToFile(`[Error] Failed to process message: ${err.message}`);
          }
        }, waitTimeMs);

        pendingReplyTimers.set(capturedRemoteJid, {
          timeoutId,
          msgId: msgSnapshot.key.id,
          senderPhone: capturedSenderPhone
        });
      }
    });

    setInterval(subscribeOwnerPresence, 20000);

  } catch (err) {
    console.error('Error in startWhatsAppSocket:', err);
    logToFile(`[Error] startWhatsAppSocket: ${err.message}`);
  } finally {
    isStartingSocket = false;
  }
}

// ----------------------------------------------------
// REST API Endpoints & Control Dashboard
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.redirect('/qr');
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    phone: userPhone,
    qr: currentQRDataURL,
    operationalStatus: getAiOperationalStatus(),
  });
});

app.get('/ai-status', (req, res) => {
  const opStatus = getAiOperationalStatus();
  const timeSinceActive = lastOwnerActiveTime > 0 ? Math.floor((Date.now() - lastOwnerActiveTime) / 1000) : null;
  res.json({
    connected: isConnected,
    phone: userPhone,
    operationalStatus: opStatus,
    settings: bridgeSettings,
    lastOwnerActiveTime,
    timeSinceOwnerActiveSec: timeSinceActive
  });
});

app.post('/pause', (req, res) => {
  const { durationMinutes } = req.body || {};
  bridgeSettings.isAiPaused = true;
  bridgeSettings.pauseUntil = (durationMinutes && Number(durationMinutes) > 0)
    ? Date.now() + (Number(durationMinutes) * 60 * 1000)
    : 0;
  saveSettings(bridgeSettings);
  const opStatus = getAiOperationalStatus();
  console.log(`🛑 [API] Meera AI paused: ${opStatus.description}`);
  logToFile(`[API] AI paused: ${opStatus.description}`);
  res.json({ success: true, operationalStatus: opStatus });
});

app.post('/resume', (req, res) => {
  bridgeSettings.isAiPaused = false;
  bridgeSettings.pauseUntil = 0;
  lastOwnerActiveTime = 0;
  humanActiveUntil.clear();
  saveSettings(bridgeSettings);
  const opStatus = getAiOperationalStatus();
  console.log(`▶️ [API] Meera AI resumed.`);
  logToFile(`[API] AI resumed.`);
  res.json({ success: true, operationalStatus: opStatus });
});

app.post('/toggle-ai', (req, res) => {
  if (bridgeSettings.isAiPaused) {
    bridgeSettings.isAiPaused = false;
    bridgeSettings.pauseUntil = 0;
    lastOwnerActiveTime = 0;
    humanActiveUntil.clear();
  } else {
    bridgeSettings.isAiPaused = true;
    bridgeSettings.pauseUntil = 0;
  }
  saveSettings(bridgeSettings);
  const opStatus = getAiOperationalStatus();
  console.log(`🔄 [API] Meera AI toggled to: ${opStatus.status}`);
  logToFile(`[API] AI toggled to: ${opStatus.status}`);
  res.json({ success: true, operationalStatus: opStatus });
});

app.get('/settings', (req, res) => {
  res.json(bridgeSettings);
});

app.post('/settings', (req, res) => {
  const { ownerInactivitySeconds, inboundWaitSeconds, chatTakeoverMinutes } = req.body || {};
  if (typeof ownerInactivitySeconds === 'number' && ownerInactivitySeconds >= 1) {
    bridgeSettings.ownerInactivitySeconds = ownerInactivitySeconds;
  }
  if (typeof inboundWaitSeconds === 'number' && inboundWaitSeconds >= 1) {
    bridgeSettings.inboundWaitSeconds = inboundWaitSeconds;
  }
  if (typeof chatTakeoverMinutes === 'number' && chatTakeoverMinutes >= 1) {
    bridgeSettings.chatTakeoverMinutes = chatTakeoverMinutes;
  }
  saveSettings(bridgeSettings);
  res.json({ success: true, settings: bridgeSettings });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    const op = getAiOperationalStatus();
    const isPaused = bridgeSettings.isAiPaused;
    return res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Meera AI - WhatsApp Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0b141a; color: #e9edef; padding: 24px 16px; }
    .container { max-width: 520px; margin: 0 auto; }
    .card { background: #111b21; border-radius: 16px; padding: 22px; border: 1px solid #202c33; box-shadow: 0 8px 24px rgba(0,0,0,0.5); margin-bottom: 16px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-active { background: #005c4b; color: #25D366; border: 1px solid #25D366; }
    .badge-stopped { background: #5c181e; color: #ff5c6d; border: 1px solid #ff5c6d; }
    .badge-owner { background: #5c4b00; color: #ffcf33; border: 1px solid #ffcf33; }
    .btn-main { width: 100%; border: none; padding: 14px 20px; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; transition: 0.2s all; display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 14px; }
    .btn-stop { background: #ea4335; color: #fff; }
    .btn-stop:hover { background: #d33828; }
    .btn-resume { background: #25D366; color: #111b21; }
    .btn-resume:hover { background: #20bd5a; }
    .btn-secondary { background: #202c33; color: #e9edef; border: 1px solid #2a3942; padding: 9px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.2s all; }
    .btn-secondary:hover { background: #2a3942; }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #1f2c34; font-size: 13px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #8696a0; }
    .info-val { color: #e9edef; font-weight: 600; }
    .hint-box { background: #182229; border-radius: 10px; padding: 14px; font-size: 12px; line-height: 1.5; color: #8696a0; border-left: 3px solid #25D366; }
    .code-tag { background: #111b21; color: #25D366; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    
    <!-- Status Card -->
    <div class="card" style="text-align:center;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <span style="font-size:12px;color:#8696a0;">WhatsApp Link: <b>+${userPhone}</b></span>
        <span id="statusBadge" class="badge ${isPaused ? 'badge-stopped' : (op.status === 'owner_active' ? 'badge-owner' : 'badge-active')}">
          ${isPaused ? '🛑 AI STOPPED' : (op.status === 'owner_active' ? '👤 OWNER IN WHATSAPP' : '🟢 AI ACTIVE')}
        </span>
      </div>

      <h2 style="font-size:22px;color:#e9edef;margin-bottom:6px;">Meera AI Timing Plan</h2>
      <p id="statusDesc" style="font-size:13px;color:#8696a0;min-height:20px;">${op.description}</p>

      <!-- Main Action Button -->
      <button id="toggleBtn" onclick="toggleAi()" class="btn-main ${isPaused ? 'btn-resume' : 'btn-stop'}">
        ${isPaused ? '▶️ START / RESUME MEERA AI' : '🛑 STOP MEERA AI MANUALLY'}
      </button>
    </div>

    <!-- Active Timing Rules Card -->
    <div class="card">
      <h3 style="font-size:14px;color:#25D366;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">⚡ Configured Timing Plan</h3>
      <div class="info-row">
        <span class="info-label">When you are active/online in WhatsApp:</span>
        <span class="info-val" style="color:#ffcf33;">Meera stops immediately (NO replies)</span>
      </div>
      <div class="info-row">
        <span class="info-label">When you close WhatsApp / go offline:</span>
        <span class="info-val" style="color:#25D366;">Meera auto-activates to help users</span>
      </div>
      <div class="info-row">
        <span class="info-label">Inbound Reply Speed:</span>
        <span class="info-val" style="color:#25D366;">Instant (0s delay when you close WhatsApp)</span>
      </div>
      <div class="info-row">
        <span class="info-label">When you message a contact:</span>
        <span class="info-val" style="color:#ff5c6d;">Meera stops in that chat for 1 min</span>
      </div>
      <div class="info-row">
        <span class="info-label">Links in WhatsApp Groups:</span>
        <span class="info-val" style="color:#ff5c6d;">100% Blocked (Never responds or replies)</span>
      </div>
    </div>

    <!-- WhatsApp Commands Guide -->
    <div class="card">
      <h3 style="font-size:14px;color:#e9edef;margin-bottom:10px;">📱 Phone Commands (Optional)</h3>
      <div class="hint-box">
        • Send <span class="code-tag">!off</span> or <span class="code-tag">stop</span> &rarr; <b>Stops AI manually</b><br>
        • Send <span class="code-tag">!on</span> or <span class="code-tag">start</span> &rarr; <b>Resumes AI auto-replies</b><br>
        • Send <span class="code-tag">!status</span> &rarr; <b>Checks live status</b>
      </div>
    </div>

    <!-- Tools & Reset -->
    <div style="display:flex;gap:10px;justify-content:center;margin-top:10px;">
      <a href="/logs" target="_blank" class="btn-secondary" style="text-decoration:none;display:inline-block;">📄 Live Bridge Logs</a>
      <a href="/reset" class="btn-secondary" style="text-decoration:none;display:inline-block;color:#f15c6d;">🔄 Reset & Re-link</a>
    </div>

  </div>

  <script>
    async function updateUi() {
      try {
        const res = await fetch('/ai-status');
        const data = await res.json();
        const op = data.operationalStatus || {};
        const isPaused = data.settings?.isAiPaused;
        const badge = document.getElementById('statusBadge');
        const desc = document.getElementById('statusDesc');
        const btn = document.getElementById('toggleBtn');

        desc.textContent = op.description || '';

        if (isPaused) {
          badge.className = 'badge badge-stopped';
          badge.textContent = '🛑 AI STOPPED';
          btn.className = 'btn-main btn-resume';
          btn.innerHTML = '▶️ START / RESUME MEERA AI';
        } else if (op.status === 'owner_active') {
          badge.className = 'badge badge-owner';
          badge.textContent = '👤 OWNER IN WHATSAPP';
          btn.className = 'btn-main btn-stop';
          btn.innerHTML = '🛑 STOP MEERA AI MANUALLY';
        } else {
          badge.className = 'badge badge-active';
          badge.textContent = '🟢 AI ACTIVE';
          btn.className = 'btn-main btn-stop';
          btn.innerHTML = '🛑 STOP MEERA AI MANUALLY';
        }
      } catch (_) {}
    }

    async function toggleAi() {
      const btn = document.getElementById('toggleBtn');
      btn.disabled = true;
      try {
        await fetch('/toggle-ai', { method: 'POST' });
        await updateUi();
      } catch (err) {
        alert('Error: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }

    setInterval(updateUi, 1000);
  </script>
</body>
</html>`);
  }

  // Not connected yet: render QR or Pairing Code page
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
          <img id="qrImg" src="${currentQRDataURL}" width="230" height="230" style="display:block;" />
        </div>
        <p style="color:#8696a0;font-size:11px;margin:12px 0 0;">WhatsApp &gt; Linked Devices &gt; Link a Device &gt; Scan QR</p>
        <p style="color:#25D366;font-size:11px;margin:4px 0 0;">● Live QR (auto-refreshes every 20s)</p>
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
          if (d.connected) { 
            location.reload(); 
          } else if (d.qr) {
            const img = document.getElementById('qrImg');
            if (img && img.src !== d.qr) {
              img.src = d.qr;
            }
          }
        } catch (_) {}
      }, 2000);
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
    if (isSessionCorruptedOrUnregistered()) {
      clearAuthDirectory();
    }
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end();
      } catch (_) {}
      sock = null;
    }
    clearAuthDirectory();
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
    clearAuthDirectory();
    isConnected = false;
    currentQR = null;
    currentQRDataURL = null;
    userPhone = null;
    return res.json({ success: true, message: 'Logged out. Ready for new QR scan.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WhatsApp Web Bridge Server] Listening on http://0.0.0.0:${PORT}`);
  startWhatsAppSocket();

  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (externalUrl) {
    console.log(`[Cloud Keep-Alive] Initialized self-pinging every 10m for ${externalUrl}`);
    setInterval(async () => {
      try {
        await axios.get(`${externalUrl}/status`, { timeout: 10000 });
      } catch (_) {}
    }, 10 * 60 * 1000);
  }
});
