/**
 * TRON Fast Auto-Sweep Bot (Block-Watching)
 * -------------------------------------------------
 * Strategi:
 *   - Memantau blok baru setiap POLL_INTERVAL_MS (default 1 detik).
 *   - Jika ada TransferContract masuk ke alamat sumber di blok tersebut,
 *     langsung menyusun & mem-broadcast transaksi sweep ke alamat tujuan.
 *   - Transaksi sweep akan masuk ke blok berikutnya (~3 detik).
 *
 * PERINGATAN KEAMANAN:
 *   - Bot ini memegang private key di memori proses.
 *   - Gunakan HANYA untuk wallet operasional dengan dana kecil.
 *   - JANGAN gunakan untuk wallet tabungan/utama.
 *   - Pastikan TRONGRID_API_KEY diisi agar tidak kena rate-limit.
 */

const { TronWeb } = require('tronweb');

// ==================== KONFIGURASI ====================
const PRIVATE_KEY     = process.env.TRON_PRIVATE_KEY;
const DEST_ADDRESS    = process.env.TRON_DEST_ADDRESS;
const TRONGRID_KEY    = process.env.TRONGRID_API_KEY || '';
const FEE_RESERVE_SUN = parseInt(process.env.FEE_RESERVE_SUN || '1000000', 10); // 1 TRX
const MIN_SWEEP_SUN   = parseInt(process.env.MIN_SWEEP_SUN   || '1000000', 10); // 1 TRX
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL_MS || '1000',    10); // 1s
const FULL_HOST       = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';

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

    if (isNaN(FEE_RESERVE_SUN) || FEE_RESERVE_SUN < 0) errs.push('FEE_RESERVE_SUN tidak valid.');
    if (isNaN(MIN_SWEEP_SUN)   || MIN_SWEEP_SUN   < 0) errs.push('MIN_SWEEP_SUN tidak valid.');
    if (isNaN(POLL_INTERVAL)   || POLL_INTERVAL   < 500) errs.push('POLL_INTERVAL_MS minimal 500 ms.');

    if (errs.length) {
        console.error('❌ Konfigurasi tidak valid:');
        errs.forEach(e => console.error('   - ' + e));
        process.exit(1);
    }

    const sourceFromKey = TronWeb.address.fromPrivateKey(PRIVATE_KEY);
    if (sourceFromKey === DEST_ADDRESS) {
        console.error('❌ Alamat sumber == alamat tujuan. Bot tidak berguna.');
        process.exit(1);
    }
    if (!TRONGRID_KEY) {
        log('WARN', 'TRONGRID_API_KEY kosong. Risiko rate-limit tinggi & sweep bisa gagal.');
    }
    return sourceFromKey;
}

// ==================== TRONWEB ====================
function createTronWeb() {
    const headers = {};
    if (TRONGRID_KEY) headers['TRON-PRO-API-KEY'] = TRONGRID_KEY;
    return new TronWeb({
        fullHost: FULL_HOST,
        privateKey: PRIVATE_KEY,
        headers,
    });
}

// ==================== STATE ====================
let lastSeenBlock = 0;
let sweepInFlight = false;
let pendingSweep = false; // agar tidak menumpuk permintaan sweep

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
            log('INFO', `Saldo ${(balance / 1e6).toFixed(6)} TRX, setelah reserve < MIN_SWEEP. Skip. (${triggerInfo})`);
            return;
        }

        log('INFO', `Sweep dipicu (${triggerInfo}). Kirim ${(sendAmount / 1e6).toFixed(6)} TRX -> ${DEST_ADDRESS}`);

        const tx = await tronWeb.transactionBuilder.sendTrx(
            DEST_ADDRESS,
            sendAmount,
            sourceAddress
        );
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
            // Jalankan sekali lagi untuk menangkap dana yang masuk saat sweep berjalan
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

        // Jika melompat banyak blok (mis. bot restart), jangan iterasi semuanya
        const startFrom = lastSeenBlock === 0 ? num : lastSeenBlock + 1;
        lastSeenBlock = num;

        // Hanya periksa blok yang baru saja kita lewati (biasanya hanya 1)
        // Untuk kesederhanaan, kita hanya periksa blok terkini `block`.
        const txs = block.transactions || [];
        for (const tx of txs) {
            const c = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0];
            if (!c || c.type !== 'TransferContract') continue;
            const v = c.parameter.value;
            if (!v || !v.to_address) continue;

            let toAddr;
            try {
                toAddr = tronWeb.address.fromHex(v.to_address);
            } catch { continue; }

            if (toAddr === sourceAddress && Number(v.amount) > 0) {
                log('INFO', `📥 Blok ${num}: menerima ${(Number(v.amount) / 1e6).toFixed(6)} TRX (txid ${tx.txID.slice(0, 12)}...)`);
                // Fire sweep segera, tidak menunggu loop berikutnya
                await doSweep(tronWeb, sourceAddress, `block ${num}`);
            }
        }
    } catch (err) {
        log('ERROR', `checkNewBlock error: ${err.message}`);
    }
}

// ==================== MAIN ====================
async function main() {
    const sourceAddress = validateConfig();
    const tronWeb = createTronWeb();

    log('INFO', '==========================================');
    log('INFO', 'TRON Fast Auto-Sweep Bot (Block-Watching)');
    log('INFO', `Sumber     : ${sourceAddress}`);
    log('INFO', `Tujuan     : ${DEST_ADDRESS}`);
    log('INFO', `Poll       : ${POLL_INTERVAL} ms`);
    log('INFO', `FeeReserve : ${(FEE_RESERVE_SUN / 1e6).toFixed(6)} TRX`);
    log('INFO', `MinSweep   : ${(MIN_SWEEP_SUN / 1e6).toFixed(6)} TRX`);
    log('INFO', `FullHost   : ${FULL_HOST}`);
    log('INFO', `API Key    : ${TRONGRID_KEY ? 'set' : 'TIDAK diset (warning)'}`);
    log('INFO', '==========================================');

    // Sinkronkan lastSeenBlock dengan blok terkini agar tidak memproses blok lama
    try {
        const cur = await tronWeb.trx.getCurrentBlock();
        lastSeenBlock = cur.block_header.raw_data.number;
        log('INFO', `Mulai dari blok #${lastSeenBlock}`);
    } catch (e) {
        log('WARN', `Gagal sinkron blok awal: ${e.message}`);
    }

    // Sweep awal untuk menangkap dana yang sudah ada sebelum bot dijalankan
    await doSweep(tronWeb, sourceAddress, 'startup');

    // Loop utama
    const timer = setInterval(() => {
        checkNewBlock(tronWeb, sourceAddress).catch(err =>
            log('ERROR', `loop error: ${err.message}`)
        );
    }, POLL_INTERVAL);

    // Graceful shutdown
    const shutdown = (sig) => {
        log('INFO', `${sig} diterima, shutdown.`);
        clearInterval(timer);
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('unhandledRejection', r => log('ERROR', `unhandledRejection: ${r}`));
    process.on('uncaughtException',  e => log('ERROR', `uncaughtException: ${e.message}`));
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});