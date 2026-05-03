require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const SENT_DB = path.join(__dirname, 'sent_recipes.json');

if (!fs.existsSync(SENT_DB)) fs.writeFileSync(SENT_DB, JSON.stringify([]));

let lastQr = null;
let botStatus = 'Initializing... ⚙️';

// --- WEB SERVER (Priorità Massima) ---
app.get('/', (req, res) => {
    if (lastQr) {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;"><h1 style="color:#25d366;">WhatsApp Scan</h1><div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById("qrcode"), {text:"${lastQr}",width:256,height:256});</script><p>Scansiona per attivare il bot</p></div><script>setTimeout(()=>location.reload(),15000);</script></body></html>`);
    } else {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;"><div style="background:white;padding:40px;border-radius:20px;text-align:center;"><h1>Air Fryer Bot</h1><p>${botStatus}</p></div><script>setTimeout(()=>location.reload(),5000);</script></body></html>`);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    
    // Avvio WhatsApp dopo 10 secondi
    setTimeout(initWhatsApp, 10000);
});

// --- WHATSAPP LOGIC ---
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        executablePath: '/usr/bin/google-chrome', // Percorso nell'immagine ufficiale puppeteer
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

function initWhatsApp() {
    console.log('📱 Initializing WhatsApp...');
    client.initialize().catch(e => console.error('Error init:', e));
}

client.on('qr', (qr) => {
    lastQr = qr;
    botStatus = 'Waiting for Scan... 📷';
    console.log('--- NEW QR CODE ---');
});

client.on('ready', () => {
    lastQr = null;
    botStatus = 'Working! ✅';
    console.log('✅ Ready!');
    startAutomation();
});

client.on('authenticated', () => {
    botStatus = 'Authenticated! 🚀';
    console.log('✅ Auth success');
});

// --- AUTOMATION ---
async function startAutomation() {
    setInterval(async () => {
        try { await checkAndPublish(); } catch (e) { console.error('Loop error:', e.message); }
    }, process.env.CHECK_INTERVAL_MINUTES * 60 * 1000);
    await checkAndPublish();
}

async function checkAndPublish() {
    const sourceUrl = process.env.WEB_SOURCE_URL;
    const channelId = process.env.WA_CHANNEL_ID;
    
    console.log('🔎 Checking recipes...');
    const { data } = await axios.get(sourceUrl);
    const $ = cheerio.load(data);
    
    const recipeLinks = [];
    $('.recipe-card a.card-link').each((i, el) => {
        const href = $(el).attr('href');
        if (href) recipeLinks.push(new URL(href, sourceUrl).href);
    });

    const sentDb = JSON.parse(fs.readFileSync(SENT_DB));
    const newRecipes = recipeLinks.filter(link => !sentDb.includes(link)).slice(0, 1); 

    for (const link of newRecipes) {
        const recipePage = await axios.get(link);
        const $r = cheerio.load(recipePage.data);
        const shareOnClick = $r('#mainShareBtn').attr('onclick');
        if (!shareOnClick) continue;

        const matches = shareOnClick.match(/unifiedShare\s*\(\s*(?:"|').*?(?:"|')\s*,\s*"((?:\\"|[^"])*)"/);
        let message = matches ? matches[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : null;

        if (message) {
            await new Promise(res => setTimeout(res, 10000)); // Delay minimo
            await client.sendMessage(channelId, message);
            sentDb.push(link);
            fs.writeFileSync(SENT_DB, JSON.stringify(sentDb.slice(-100)));
            console.log(`🚀 Sent: ${link}`);
        }
    }
}
