const TronWeb = require('tronweb');
const http = require('http');

// ==================== KONFIGURASI ====================
const PRIVATE_KEY     = process.env.TRON_PRIVATE_KEY;
const DEST_ADDRESS    = process.env.TRON_DEST_ADDRESS;
const TRONGRID_KEY    = process.env.TRONGRID_API_KEY || '';
const FEE_RESERVE_SUN = parseInt(process.env.FEE_RESERVE_SUN || '1000000', 10);
const MIN_SWEEP_SUN   = parseInt(process.env.MIN_SWEEP_SUN   || '1000000', 10);
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || '1000',    10);
const FULL_HOST       = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';

// ==================== DUMMY WEB SERVER ====================
// Railway akan mematikan service jika tidak ada port HTTP yang terbuka.
// Server ini memastikan Railway menganggap bot ini "hidup".
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
}).listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [INFO] Dummy server berjalan di port ${PORT}`);
});

// ==================== LOGGING ====================
function log(level, msg) {
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

// ==================== VALIDASI ====================
function validateConfig() {
    const errs = [];
    if (!PRIVATE_KEY) errs.push('TRON_PRIVATE_KEY tidak diset.');
    else if (!/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) errs.push('TRON_PRIVATE_KEY harus 64 hex chars.');

    if (!DEST_ADDRESS) errs.push('TRON_DEST_ADDRESS tidak diset.');
    else if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(DEST_ADDRESS)) errs.push('TRON_DEST_ADDRESS format tidak valid.');

    if (errs.length) {
        return { valid: false, errs };
    }

    let sourceFromKey;
    try {
        // Deteksi class TronWeb (antisipasi perbedaan versi library)
        const TronWebClass = TronWeb.TronWeb || TronWeb; 
        sourceFromKey = TronWebClass.address.fromPrivateKey(PRIVATE_KEY);
    } catch (e) {
        return { valid: false, errs: [`Gagal memproses Private Key: ${e.message}`] };
    }

    if (sourceFromKey === DEST_ADDRESS) {
        return { valid: false, errs: ['Alamat sumber == alamat tujuan.'] };
    }
    
    if (!TRONGRID_KEY) {
        log('WARN', 'TRONGRID_API_KEY kosong. Risiko rate-limit tinggi.');
    }
    return { valid: true, sourceFromKey };
}

// ==================== TRONWEB ====================
function createTronWeb() {
    const headers = {};
    if (TRONGRID_KEY) headers['TRON-PRO-API-KEY'] = TRONGRID_KEY;
    
    const TronWebClass = TronWeb.TronWeb || TronWeb;

    return new TronWebClass({
        fullHost: FULL_HOST,
        privateKey: PRIVATE_KEY,
        headers,
    });
}

// ==================== STATE ====================
let lastSeenBlock = 0;
let sweepInFlight = false;
let pendingSweep = false;

// ==================== CORE: SWEEP ====================
async function doSweep(tronWeb, sourceAddress, triggerInfo) {
    if (sweepInFlight) {
        pendingSweep = true;
        return;
    }
    sweepInFlight = true;

    try {
        const balance = await tronWeb.trx.getBalance(sourceAddress);
        const sendAmount = balance - FEE_RESERVE_SUN;

        if (sendAmount < MIN_SWEEP_SUN) {
            log('INFO', `Saldo ${(balance / 1e6).toFixed(6)} TRX, skip. (${triggerInfo})`);
            return;
        }

        log('INFO', `Sweep dipicu (${triggerInfo}). Kirim ${(sendAmount / 1e6).toFixed(6)} TRX -> ${DEST_ADDRESS}`);

        const tx = await tronWeb.transactionBuilder.sendTrx(DEST_ADDRESS, sendAmount, sourceAddress);
        const signed = await tronWeb.trx.sign(tx);
        const res = await tronWeb.trx.sendRawTransaction(signed);

        if (res && res.result) {
            log('SUCCESS', `✅ Sweep terkirim. TXID: ${res.txid}`);
        } else {
            log('ERROR', `❌ Broadcast gagal: ${JSON.stringify(res)}`);
        }
    } catch (err) {
        log('ERROR', `Sweep error: ${err.message}`);
    } finally {
        sweepInFlight = false;
        if (pendingSweep) {
            pendingSweep = false;
            setImmediate(() => doSweep(tronWeb, sourceAddress, 'follow-up'));
        }
    }
}

// ==================== BLOCK WATCHER ====================
async function checkNewBlock(tronWeb, sourceAddress) {
    try {
        const block = await tronWeb.trx.getCurrentBlock();
        if (!block || !block.block_header) return;

        const num = block.block_header.raw_data.number;
        if (num <= lastSeenBlock) return;

        lastSeenBlock = num;
        const txs = block.transactions || [];
        for (const tx of txs) {
            const c = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
            if (!c || c.type !== 'TransferContract') continue;
            const v = c.parameter.value;
            if (!v || !v.to_address) continue;

            let toAddr;
            try { toAddr = tronWeb.address.fromHex(v.to_address); } catch { continue; }

            if (toAddr === sourceAddress && Number(v.amount) > 0) {
                log('INFO', `📥 Blok ${num}: menerima ${(Number(v.amount) / 1e6).toFixed(6)} TRX`);
                await doSweep(tronWeb, sourceAddress, `block ${num}`);
            }
        }
    } catch (err) {
        log('ERROR', `checkNewBlock error: ${err.message}`);
    }
}

// ==================== MAIN LOOP ====================
async function runBot() {
    const check = validateConfig();
    
    if (!check.valid) {
        log('ERROR', '❌ Konfigurasi tidak valid:');
        check.errs.forEach(e => log('ERROR', `   - ${e}`));
        log('WARN', 'Menunggu 10 detik sebelum mencoba lagi... Pastikan Variables di Railway sudah diisi dan di-Deploy.');
        setTimeout(runBot, 10000);
        return;
    }

    const sourceAddress = check.sourceFromKey;
    const tronWeb = createTronWeb();

    log('INFO', '==========================================');
    log('INFO', 'TRON Fast Auto-Sweep Bot BERJALAN');
    log('INFO', `Sumber     : ${sourceAddress}`);
    log('INFO', `Tujuan     : ${DEST_ADDRESS}`);
    log('INFO', `Poll       : ${POLL_INTERVAL} ms`);
    log('INFO', `API Key    : ${TRONGRID_KEY ? 'set' : 'TIDAK diset'}`);
    log('INFO', '==========================================');

    try {
        const cur = await tronWeb.trx.getCurrentBlock();
        lastSeenBlock = cur.block_header.raw_data.number;
        log('INFO', `Mulai dari blok #${lastSeenBlock}`);
    } catch (e) {
        log('WARN', `Gagal sinkron blok awal: ${e.message}`);
    }

    await doSweep(tronWeb, sourceAddress, 'startup');

    setInterval(() => {
        checkNewBlock(tronWeb, sourceAddress).catch(err =>
            log('ERROR', `loop error: ${err.message}`)
        );
    }, POLL_INTERVAL);
}

// Jalankan Bot
runBot();
