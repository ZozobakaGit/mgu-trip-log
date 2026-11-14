'use strict';
const fs = require('fs');

const catalogPath = '/etc/oap/someip/someip-interfaces.json';
const cruise = /cruise|abstandsregel|geschwindigkeitsregel|sollgeschwindigkeit|wunschgeschwindigkeit|(?:driver|driving)assist|fahrerassist|(?:cruise|acc)(?:status|set|active)|(?:^|[._])acc(?:$|[._])/i;
const speed = /(?:set|desired|target|selected)(?:vehicle)?speed|geschwindigkeit/i;
const steering = /lane.?center|lenkassist|spurfu.hrung/i;

function scan(file) {
    const data = JSON.parse(fs.readFileSync(file || catalogPath, 'utf8'));
    const candidates = [];
    for (const iface of Object.keys(data.interfaces || {}).sort()) {
        const instanceIds = data.instanceIDs && data.instanceIDs[iface];
        if (!instanceIds) continue;
        const fields = data.interfaces[iface].fields || {};
        for (const field of Object.keys(fields).sort()) {
            const def = fields[field];
            const direct = cruise.test(field) || cruise.test(JSON.stringify(def));
            const related = cruise.test(iface) && (speed.test(field) || /status|state|mode|active|request/i.test(field));
            if (!direct && !related && !steering.test(field)) continue;
            const access = (def.getter && def.getter.id ? 'r' : '') + (def.notifier && typeof def.notifier === 'object' ? 's' : '');
            if (!access) continue;
            candidates.push({ iface, field, access, instance: Object.keys(instanceIds).sort().find((id) => instanceIds[id]) || null,
                rank: direct ? 0 : related ? 1 : 2 });
        }
    }
    return candidates.sort((a,b) => a.rank - b.rank);
}

function choose(candidates) {
    const out = {};
    for (const c of candidates) {
        if (!c.instance) continue;
        if (!out[c.iface] && Object.keys(out).length < 4) out[c.iface] = { _instances: c.instance, _optional: 'Cruise probe' };
        const fields = out[c.iface];
        if (fields && fields._instances === c.instance && Object.keys(fields).length < 6) fields[c.field] = c.access;
    }
    return out;
}

module.exports = { scan, choose };
if (require.main === module) {
    try { process.stdout.write(JSON.stringify(choose(scan(process.argv[2])))); }
    catch (e) { console.error('Cruise catalog: ' + e.message); process.stdout.write('{}'); }
}
