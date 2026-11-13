'use strict';
const fs = require('fs');
const path = require('path');
const catalog = '/etc/oap/someip/someip-interfaces.json';
const words = /cruise|abstandsregel|geschwindigkeitsregel|sollgeschwindigkeit|wunschgeschwindigkeit|set(?:point|speed)|targetspeed|desiredspeed|speedlimit|geschwindigkeitsbegrenzer|fahrerassist|driverassist|lane.?center|lenkassist|spurfu.hrung|longitudinalcontrol|laengsregel|(?:^|[^a-z])acc(?:status|set|active|[^a-z]|$)/i;

function scan(dir) {
    let candidates = [], error = null;
    try {
        const data = JSON.parse(fs.readFileSync(catalog, 'utf8'));
        const interfaces = data.interfaces || data;
        candidates = Object.keys(interfaces).filter((name) => words.test(name) ||
            words.test(JSON.stringify(interfaces[name]))).map((name) => ({ name, definition: interfaces[name] }));
    } catch (e) { error = e.message; }
    const report = {
        timestamp: new Date().toISOString(), catalog, error,
        bimmerlink_observations: { 3584: 'baseline', 520: 'Professional observed', 521: 'Professional observed', 776: 'LIM observed' },
        note: 'Observed values, not diagnostic addresses. Candidate definitions are not verified live signals.',
        candidates
    };
    fs.writeFileSync(path.join(dir, 'cruise-diagnostics.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
}

module.exports = { scan };
