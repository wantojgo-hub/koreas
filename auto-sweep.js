const TronWeb = require('tronweb');
const http = require('http');

// ==================== KONFIGURASI ====================
const PRIVATE_KEY     = process.env.TRON_PRIVATE_KEY;
const DEST_ADDRESS    = process.env.TRON_DEST_ADDRESS;
const TRONGRID_KEY    = process.env.TRONGRID_API_KEY || '';
const FEE_RESERVE_SUN = parseInt(process.env.FEE_RESERVE_SUN || '1000000', 10);
const MIN_SWEEP_SUN   = parseInt(process.env.MIN_SWEEP_SUN   || '1000000', 10);
// PERCEPATAN: Turunkan interval deteksi menjadi 500ms (batas laju TronGrid dengan API Key masih mencukupi)
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || '500', 10);
const FULL_HOST       = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';

// ==================== DUMMY WEB SERVER ====================
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Security Bot is running\n');
}).listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [INFO] Web server aktif di port ${PORT}`);
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

    if (errs.length) return { valid: false, errs };

    let sourceFromKey;
    try {
        const TronWebClass = TronWeb.TronWeb || TronWeb;
        sourceFromKey = TronWebClass.address.fromPrivateKey(PRIVATE_KEY);
    } catch (e) {
        return { valid: false, errs: [`Gagal memproses Private Key: ${e.message}`] };
    }

    if (sourceFromKey === DEST_ADDRESS) {
        return { valid: false, errs: ['Alamat sumber == alamat tujuan.'] };
    }

    if (!TRONGRID_KEY) {
        log('WARN', '⚠️ API Key kosong. Interval 500ms akan menyebabkan limit (429) parah.');
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
let rateLimitCooldown = 0;

// ==================== CORE: SWEEP (JALUR CEPAT) ====================
// PERCEPATAN: Menerima parameter amount, melewati pengecekan getBalance.
// Setelah mendeteksi dana masuk di blok, langsung menandatangani dan broadcast.
async function doSweepFast(tronWeb, sourceAddress, amountSun, triggerInfo) {
    if (sweepInFlight) return;
    sweepInFlight = true;

    try {
        // Hitung jumlah transfer: jumlah yang terdeteksi di blok dikurangi cadangan biaya
        const sendAmount = amountSun - FEE_RESERVE_SUN;

        if (sendAmount < MIN_SWEEP_SUN) {
            log('INFO', `Jumlah ${(amountSun / 1e6).toFixed(6)} TRX terlalu kecil, lewati. (${triggerInfo})`);
            return;
        }

        log('INFO', `⚡ PENYELAMATAN KILAT (${triggerInfo}). Mengirim ${(sendAmount / 1e6).toFixed(6)} TRX -> ${DEST_ADDRESS}`);

        // Langsung membangun, menandatangani, dan broadcast (tanpa getBalance)
        const tx = await tronWeb.transactionBuilder.sendTrx(DEST_ADDRESS, sendAmount, sourceAddress);
        const signed = await tronWeb.trx.sign(tx);
        const res = await tronWeb.trx.sendRawTransaction(signed);

        if (res && res.result) {
            log('SUCCESS', `✅ DANA AMAN. TXID: ${res.txid}`);
        } else {
            log('ERROR', `❌ Gagal broadcast: ${JSON.stringify(res)}`);
        }
    } catch (err) {
        log('ERROR', `Sweep error: ${err.message}`);
    } finally {
        sweepInFlight = false;
    }
}

// ==================== BLOCK WATCHER ====================
async function checkNewBlock(tronWeb, sourceAddress) {
    if (Date.now() < rateLimitCooldown) return;

    try {
        // PERCEPATAN: Gunakan getNowBlock (titik akhir lebih ringan) bukan getCurrentBlock
        const block = await tronWeb.trx.getNowBlock();
        if (!block || !block.block_header) return;

        const num = block.block_header.raw_data.number;
        if (num <= lastSeenBlock) return;

        lastSeenBlock = num;
        const txs = block.transactions || [];

        // Pindai secara terbalik (dari yang terbaru), karena transaksi masuk Anda kemungkinan besar berada di akhir blok
        for (let i = txs.length - 1; i >= 0; i--) {
            const tx = txs[i];
            const c = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
            if (!c || c.type !== 'TransferContract') continue;
            const v = c.parameter.value;
            if (!v || !v.to_address) continue;

            let toAddr;
            try { toAddr = tronWeb.address.fromHex(v.to_address); } catch { continue; }

            if (toAddr === sourceAddress && Number(v.amount) > 0) {
                log('INFO', `🚨 Blok ${num}: mendeteksi ${(Number(v.amount) / 1e6).toFixed(6)} TRX masuk!`);
                // Menggunakan setImmediate untuk memastikan tidak memblokir siklus event loop
                setImmediate(() => doSweepFast(tronWeb, sourceAddress, Number(v.amount), `Blok ${num}`));
                return; // Setelah memproses satu, keluar langsung untuk menghindari pemrosesan berulang
            }
        }
    } catch (err) {
        if (err.message && (err.message.includes('429') || err.message.includes('403'))) {
            log('WARN', `⚠️ Rate limit (429). Jeda 15 detik agar tidak diblokir permanen...`);
            rateLimitCooldown = Date.now() + 15000; // Persingkat waktu cooldown untuk pulih lebih cepat
        } else {
            log('ERROR', `Pemantauan error: ${err.message}`);
        }
    }
}

// ==================== MAIN LOOP ====================
async function runBot() {
    const check = validateConfig();

    if (!check.valid) {
        log('ERROR', '❌ Konfigurasi tidak valid:');
        check.errs.forEach(e => log('ERROR', `   - ${e}`));
        setTimeout(runBot, 10000);
        return;
    }

    const sourceAddress = check.sourceFromKey;
    const tronWeb = createTronWeb();

    log('INFO', '==========================================');
    log('INFO', '🛡️  TRON ASSET SECURITY BOT (MODE KOMPETISI)');
    log('INFO', `Dompet Asal : ${sourceAddress}`);
    log('INFO', `Dompet Aman : ${DEST_ADDRESS}`);
    log('INFO', `Deteksi     : ${POLL_INTERVAL} ms (Jalur Cepat)`);
    log('INFO', `API Key     : ${TRONGRID_KEY ? 'TERPASANG' : 'KOSONG (Bahaya)'}`);
    log('INFO', '==========================================');

    try {
        const cur = await tronWeb.trx.getNowBlock();
        lastSeenBlock = cur.block_header.raw_data.number;
        log('INFO', `Memantau mulai dari Blok #${lastSeenBlock}`);
    } catch (e) {
        log('WARN', `Sinkronisasi awal gagal: ${e.message}`);
    }

    // Pengecekan awal menggunakan metode doSweepFast (memerlukan saldo aktual, jadi kita perlu membaca saldo sekali di awal)
    try {
        const initialBalance = await tronWeb.trx.getBalance(sourceAddress);
        if (initialBalance > FEE_RESERVE_SUN) {
            log('INFO', `Saldo awal terdeteksi, menyapu...`);
            await doSweepFast(tronWeb, sourceAddress, initialBalance, 'Pengecekan Awal');
        }
    } catch (e) {
        log('WARN', `Pengecekan saldo awal gagal: ${e.message}`);
    }

    setInterval(() => {
        checkNewBlock(tronWeb, sourceAddress).catch(() => {});
    }, POLL_INTERVAL);
}

// Jalankan
runBot();
