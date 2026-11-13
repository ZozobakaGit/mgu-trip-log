'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const keys = ['mode', 'engine', 'startStop', 'cruise', 'setKmh', 'cruiseRaw'];
const time = (t) => new Date(t).toISOString();
const num = Number.isFinite;
const round = (n) => Math.round(n * 1000000) / 1000000;

class Journal {
    constructor(dir) {
        this.dir = dir;
        this.history = [];
        this.pending = [];
        this.active = null;
        this.last = null;
        this.resets = [0, 0, 0];
        const file = path.join(dir, 'counters.json');
        if (fs.existsSync(file)) this.resets = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const name of fs.readdirSync(dir).filter((n) => /^trip-\d+-[a-f0-9]+\.jsonl$/.test(n))) {
            const rows = this.read(name);
            if (rows.length) this.history.push({ name, summary: summary(rows), rows: null });
        }
        this.history.sort((a, b) => a.summary.start - b.summary.start);
    }

    read(name) {
        const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
        const lines = text.split('\n');
        lines.pop(); // A final partial line can remain after power loss.
        return lines.filter(Boolean).map(JSON.parse);
    }

    add(type, at, data) {
        const row = Object.assign({ type, trip_id: this.active.id, timestamp: time(at), at }, data);
        this.active.rows.push(row);
        this.pending.push(JSON.stringify(row) + '\n');
    }

    flush() {
        if (!this.pending.length) return;
        const file = path.join(this.dir, this.active.name);
        const fd = fs.openSync(file, 'a+', 0o600);
        const before = fs.fstatSync(fd).size;
        try {
            fs.writeFileSync(fd, this.pending.join(''), 'utf8');
            fs.fsyncSync(fd);
        } catch (e) {
            fs.ftruncateSync(fd, before);
            throw e;
        } finally {
            fs.closeSync(fd);
        }
        this.pending = [];
    }

    sample(at, data) {
        if (this.active && this.last && at - this.last.at > 120000) this.end(this.last.at);
        if (data.stage === 'P' && this.active && data.engine === 'off') {
            this.end(at);
            return;
        }
        if (!this.active && num(data.speed) && data.speed >= 2) {
            const id = at + '-' + crypto.randomBytes(4).toString('hex');
            this.active = { id, name: 'trip-' + id + '.jsonl', rows: [] };
            this.add('start', at, {});
        }
        if (!this.active) return;
        const previous = this.last;
        const dt = previous ? at - previous.at : 0;
        const valid = dt > 0 && dt <= 3000 && num(data.speed) && num(previous.speed);
        const km = valid ? round((previous.speed + data.speed) / 2 * dt / 3600000) : null;
        const liters = valid && num(previous.lph) ? round(previous.lph * dt / 3600000) : null;
        for (const key of keys) {
            if ((!previous && data[key] != null) || (previous && previous[key] !== data[key])) {
                this.add('change', at, { field: key, value: data[key] });
            }
        }
        this.add('sample', at, Object.assign({}, data, {
            dt: valid ? dt : 0, km, liters, interval_mode: previous && previous.mode,
            interval_cruise: previous && previous.cruise,
            stopped_ms: valid && previous.startStop === true && previous.speed < 1 && data.speed < 1 ? dt : 0,
            stopped_known_ms: valid && typeof previous.startStop === 'boolean' ? dt : 0
        }));
        this.last = Object.assign({ at }, data);
    }

    end(at) {
        if (!this.active) return;
        if (this.active.rows[this.active.rows.length - 1].type !== 'end') this.add('end', at, {});
        this.flush();
        this.history.push({ name: this.active.name, summary: summary(this.active.rows), rows: null });
        this.active = null;
        this.last = null;
    }

    reset(index, at) {
        const resets = this.resets.slice();
        resets[index] = at;
        const file = path.join(this.dir, 'counters.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(resets), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
        this.resets = resets;
        if (this.active) {
            this.add('reset', at, { counter: index + 1 });
            this.flush();
        }
    }

    rows(entry) {
        if (entry.rows) return entry.rows;
        if (!this.cache || this.cache.name !== entry.name) this.cache = { name: entry.name, rows: this.read(entry.name) };
        return this.cache.rows;
    }
    entries() {
        return this.active ? this.history.concat({ name: this.active.name, rows: this.active.rows, summary: summary(this.active.rows) }) : this.history;
    }

    counter(index) {
        const since = this.resets[index];
        const total = blank();
        for (const entry of this.entries()) {
            if (entry.summary.end <= since) continue;
            const part = entry.summary.start >= since ? entry.summary : summary(this.rows(entry), since);
            merge(total, part);
        }
        return total;
    }
}

function blank() {
    return { km: 0, ms: 0, fuel: 0, fuelKm: 0, fuelMs: 0, cruiseKm: 0, cruiseKnownKm: 0, stopped: 0,
        stoppedKnown: 0, modes: { eco: 0, comfort: 0, sport: 0, other: 0, unknown: 0 } };
}

function merge(a, b) {
    for (const k of ['km','ms','fuel','fuelKm','fuelMs','cruiseKm','cruiseKnownKm','stopped','stoppedKnown']) a[k] += b[k];
    for (const k of Object.keys(a.modes)) a.modes[k] += b.modes[k];
    return a;
}

function summary(rows, since) {
    const s = blank();
    s.start = rows.length ? rows[0].at : 0;
    s.end = s.start;
    for (const r of rows) {
        s.end = Math.max(s.end, r.at);
        if (r.type !== 'sample' || !r.dt) continue;
        const ratio = since == null ? 1 : Math.max(0, Math.min(1, (r.at - since) / r.dt));
        const km = r.km * ratio;
        s.km += km;
        s.ms += r.dt * ratio;
        s.modes[r.interval_mode || 'unknown'] += km;
        if (num(r.liters)) {
            s.fuel += r.liters * ratio;
            s.fuelKm += km;
            s.fuelMs += r.dt * ratio;
        }
        if (typeof r.interval_cruise === 'boolean') s.cruiseKnownKm += km;
        if (r.interval_cruise === true) s.cruiseKm += km;
        s.stopped += r.stopped_ms * ratio;
        s.stoppedKnown += r.stopped_known_ms * ratio;
    }
    return s;
}

function cruiseSteps(samples, maxTransientMs) {
    const segments = [];
    for (let i = 0; i + 1 < samples.length; i++) {
        const a = samples[i], b = samples[i + 1];
        if (a.cruise !== true || !num(a.setKmh) || b.at <= a.at || b.at - a.at > 3000) continue;
        const last = segments[segments.length - 1];
        if (last && last.end === a.at && last.kmh === a.setKmh) last.end = b.at;
        else segments.push({ start: a.at, end: b.at, kmh: a.setKmh });
    }
    const output = [];
    let pending = null;
    for (const s of segments) {
        if (!pending || pending.end !== s.start || pending.end - pending.start >= maxTransientMs) {
            if (pending) output.push(pending);
            pending = Object.assign({}, s);
        } else {
            pending.end = s.end;
            pending.kmh = s.kmh;
        }
    }
    if (pending) output.push(pending);
    return output;
}

module.exports = { Journal, summary, cruiseSteps };
