'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

const table = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    return c >>> 0;
});

function zip(files) {
    const body = [], central = [];
    let offset = 0, centralSize = 0;
    for (const name of Object.keys(files)) {
        const filename = Buffer.from(name);
        const data = Buffer.from(files[name]);
        const compressed = zlib.deflateRawSync(data);
        let crc = 0xffffffff;
        for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(33, 12);
        local.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(filename.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        local.copy(entry, 6, 4, 30);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, filename);
        centralSize += entry.length + filename.length;
        body.push(local, filename, compressed);
        offset += local.length + filename.length + compressed.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length / 2, 8);
    end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat(body.concat(central, end));
}

function csvRow(values) {
    return values.map((v) => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\r\n';
}

function archive(journal, entries, diagnosticsOnly) {
    const fields = ['trip_id','timestamp','speed','rpm','stage','mode','engine','startStop','cruise','cruiseRaw','setKmh','lph','km','liters'];
    const files = {};
    if (!diagnosticsOnly) {
        let samples = csvRow(fields), events = csvRow(['trip_id','timestamp','type','field','value','counter']);
        let trips = csvRow(['trip_id','start','end','km','avg_kmh','fuel_l','fuel_coverage_ms','cruise_km','cruise_known_km','start_stop_ms','start_stop_known_ms','eco_km','comfort_km','sport_km','other_km','unknown_mode_km']);
        let bytes = 0;
        for (const entry of entries) {
            const rows = journal.rows(entry);
            const id = rows[0].trip_id;
            const s = entry.summary;
            trips += csvRow([id,new Date(s.start).toISOString(),new Date(s.end).toISOString(),s.km,
                s.ms ? s.km * 3600000 / s.ms : null,s.fuelMs ? s.fuel : null,s.fuelMs,
                s.cruiseKnownKm ? s.cruiseKm : null,s.cruiseKnownKm,s.stoppedKnown ? s.stopped : null,
                s.stoppedKnown,s.modes.eco,s.modes.comfort,s.modes.sport,s.modes.other,s.modes.unknown]);
            const raw = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            bytes += Buffer.byteLength(raw);
            if (bytes > 16 * 1024 * 1024) throw new Error('Выбери меньший период');
            files['raw/' + entry.name] = raw;
            for (const r of rows) {
                if (r.type === 'sample') samples += csvRow(fields.map((f) => r[f]));
                else events += csvRow([r.trip_id,r.timestamp,r.type,r.field,r.value,r.counter]);
            }
        }
        Object.assign(files, { 'samples.csv': samples, 'events.csv': events, 'trips.csv': trips });
    }
    const report = path.join(journal.dir, 'cruise-diagnostics.json');
    if (fs.existsSync(report)) files['cruise-diagnostics.json'] = fs.readFileSync(report);
    return zip(files);
}

function serve(build, onClose) {
    const addresses = [].concat(...Object.values(os.networkInterfaces()));
    const ip = addresses.find((a) => a.family === 'IPv4' && /^172\.16\.222\./.test(a.address));
    if (!ip) return Promise.reject(new Error('Хотспот BMW недоступен'));
    const token = crypto.randomBytes(18).toString('hex');
    const route = '/' + token + '/trips.zip';
    return new Promise((resolve, reject) => {
        let timer, data;
        const server = http.createServer((req, res) => {
            if (req.method !== 'GET' || req.url !== route) { res.writeHead(404); res.end(); return; }
            try {
                if (!data) data = build();
                res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length,
                    'Content-Disposition': 'attachment; filename="bmw-trip-log.zip"', 'Cache-Control': 'no-store' });
                res.end(data);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(e.message);
            }
        });
        server.timeout = 30000;
        const sockets = new Set();
        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        server.once('error', reject);
        const close = () => { clearTimeout(timer); server.close(); for (const s of sockets) s.destroy(); };
        server.once('close', onClose);
        server.listen(0, ip.address, () => {
            timer = setTimeout(close, 5 * 60000);
            resolve({ url: 'http://' + ip.address + ':' + server.address().port + route, close });
        });
    });
}

module.exports = { archive, serve, zip };
