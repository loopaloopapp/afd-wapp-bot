require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

let lastQrData = null;
let botStatus = 'Initializing... ⚙️';
let sock = null;

async function useRedisAuthState() {
    const writeData = async (data, key) => {
        await redis.set(`afd:${key}`, JSON.stringify(data, BufferJSON.replacer));
    };

    const readData = async (key) => {
        const data = await redis.get(`afd:${key}`);
        return data ? JSON.parse(data, BufferJSON.reviver) : null;
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    await Promise.all(
                        Object.entries(data).flatMap(([type, ids]) =>
                            Object.entries(ids).map(([id, value]) =>
                                value
                                    ? writeData(value, `${type}-${id}`)
                                    : redis.del(`afd:${type}-${id}`)
                            )
                        )
                    );
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function getSentRecipes() {
    try {
        if (redis) {
            const data = await redis.get('afd:sent_recipes');
            return data ? JSON.parse(data) : [];
        }
    } catch (e) {}
    const localPath = path.join(AUTH_DIR, 'sent_recipes.json');
    if (!fs.existsSync(localPath)) fs.writeFileSync(localPath, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(localPath));
}

async function saveSentRecipes(recipes) {
    try {
        if (redis) {
            await redis.set('afd:sent_recipes', JSON.stringify(recipes.slice(-100)));
            return;
        }
    } catch (e) {}
    const localPath = path.join(AUTH_DIR, 'sent_recipes.json');
    fs.writeFileSync(localPath, JSON.stringify(recipes.slice(-100)));
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', async (req, res) => {
    if (lastQrData) {
        try {
            const qrImage = await QRCode.toDataURL(lastQrData);
            return res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Scan QR Code</h1><img src="${qrImage}" style="width:300px;" /><p>Apri WhatsApp > Dispositivi Collegati</p></div><script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
        } catch (e) { return res.send('Errore QR'); }
    }
    res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p style="font-size:1.5em;">${botStatus}</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
});

app.get('/test-send', async (req, res) => {
    if (!sock || !sock.user) return res.send('Bot non collegato!');
    try {
        await checkAndPublish(true);
        res.send('Test inviato al canale con foto!');
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    setTimeout(connectToWhatsApp, 5000);
});

async function connectToWhatsApp() {
    let state, saveCreds;

    if (redis) {
        console.log('🔴 Using Redis for session storage');
        try {
            ({ state, saveCreds } = await useRedisAuthState());
        } catch (e) {
            console.error('Redis auth error, falling back to local:', e.message);
            ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
        }
    } else {
        console.log('📁 Using local file for session storage');
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    }

    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestBaileysVersion();
        if (latest && latest.version) version = latest.version;
    } catch (e) {}

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ['Mac OS', 'Chrome', '121.0.6167.184'],
        printQRInTerminal: false
    });

    console.log('🔌 Socket created, waiting...');
sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { lastQrData = qr; botStatus = 'Waiting for Scan... 📷'; }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : 0;
            botStatus = 'Reconnecting... 🔄';
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Logged out, clearing session');
                if (redis) redis.del('afd:creds');
            }
            setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            lastQrData = null;
            botStatus = 'Bot is Active! ✅';
            console.log('✅ WhatsApp Connesso');
            startAutomation();
        }
    });
}

async function startAutomation() {
    const interval = (process.env.CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, interval);
    await checkAndPublish();
}

async function checkAndPublish(force = false) {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    let channelId = process.env.WA_CHANNEL_ID;

    if (!channelId || channelId.trim() === "" || channelId.startsWith('http')) {
        channelId = '120363425032237179@newsletter';
    }

    console.log(`🔍 Controllo nuove ricette su: ${sourceUrl}`);
    try {
        const { data } = await axios.get(sourceUrl);
        const $ = cheerio.load(data);
        const recipeLinks = [];

        $('.recipe-card a.card-link').each((i, el) => {
            const href = $(el).attr('href');
            if (href) recipeLinks.push(new URL(href, sourceUrl).href);
        });

        console.log(`📚 Trovate ${recipeLinks.length} ricette totali sul sito.`);

        const sentDb = await getSentRecipes();
        const newRecipes = force ? [recipeLinks[0]] : recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 1);

        if (newRecipes.length === 0) {
            console.log("✅ Nessuna nuova ricetta da pubblicare.");
            return;
        }

        for (const link of newRecipes) {
            try {
                console.log(`📖 Analisi ricetta: ${link}`);
                const recipePage = await axios.get(link);
                const $r = cheerio.load(recipePage.data);

                const imageUrl = $r('meta[property="og:image"]').attr('content') || $r('.recipe-header img').attr('src');
                const absoluteImageUrl = imageUrl ? new URL(imageUrl, link).href : null;

                const shareBtn = $r('#mainShareBtn');
                if (shareBtn.length === 0) {
                    console.log("⚠️ Pulsante share non trovato, salto.");
                    continue;
                }

                const shareOnClick = shareBtn.attr('onclick');
                const decodedOnClick = shareOnClick.replace(/&quot;/g, '"');

                const matches = decodedOnClick.match(/unifiedShare\s*\(\s*".*?"\s*,\s*"(.*?)"\s*,/);
                let message = null;
                if (matches) {
                    message = matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\//g, '/');
                }

                if (!message) {
                    console.log("⚠️ Impossibile estrarre il messaggio dalla ricetta, salto.");
                    continue;
                }

                if (sock && sock.user) {
                    const lines = message.split('\n');
                    if (lines.length > 0) {
                        lines[0] = `*${lines[0].trim()}*`;
                        message = lines.join('\n');
                    }

                    console.log(`🚀 Inviando a WhatsApp: ${lines[0]}`);

                    if (absoluteImageUrl) {
                        await sock.sendMessage(channelId, {
                            image: { url: absoluteImageUrl },
                            caption: message
                        });
                    } else {
                        await sock.sendMessage(channelId, { text: message });
                    }

                    if (!force) {
                        sentDb.push(link);
                        await saveSentRecipes(sentDb);
                    }
                    console.log("✅ Ricetta pubblicata con successo!");
                } else {
                    console.log("❌ Bot non ancora connesso a WhatsApp.");
                }
            } catch (err) {
                console.error(`❌ Errore durante l'elaborazione di ${link}:`, err.message);
            }
        }
    } catch (e) {
        console.error(`❌ Errore durante il caricamento della home:`, e.message);
    }
}
