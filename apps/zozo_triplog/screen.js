'use strict';
const qrCode = require('./qrcode');
const { cruiseSteps } = require('./journal');
const tabs = ['Последняя', 'История', 'T1', 'T2', 'T3', 'Экспорт', 'Диагностика'];
const colors = { eco: '#00ace7', comfort: '#a7afb8', sport: '#f33c53' };
const fmt = (x, n) => Number.isFinite(x) ? x.toFixed(n).replace('.', ',') : '—';
const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const day = (ms) => new Date(ms).toLocaleDateString('ru-RU') + ' ' + clock(ms);
let cachedUrl, cachedQr;

function draw(cv, journal, state, a) {
    const txt = (s, x, y, size, color, align) => cv.text(s, x, y, size, color || '#f4f6fa', { literal: true, font: 'label', align: align || 'left' });
    const line = (x, y, xx, yy, color) => cv.line(x, y, xx, yy, 2, color || '#586172');
    const panel = (x, y, w, h, name) => {
        cv.fillRect(x, y, w, h, '#10141d');
        line(x, y, x + w, y);
        ['#43cdf6','#1761cc','#ed2847'].forEach((c, i) => cv.fillRect(x + i * 23, y - 1, 21, 4, c));
        txt(name, x + 18, y + 35, 26);
    };
    const button = (title, x, y, w, fn, selected) => {
        cv.roundRect(x, y, w, 47, 4, '#191d27');
        cv.strokeRoundRect(x, y, w, 47, 4, 2, selected ? '#f33c53' : '#4f5968');
        txt(title, x + 12, y + 32, 24);
        if (cv.target) cv.target(x, y, w, 47, fn, title, 4);
    };
    const cruisePct = (s) => s.km > 0 && s.cruiseKnownKm >= s.km * 0.999 ? s.cruiseKm / s.km * 100 : null;
    const fuelAvg = (s) => s.km > 0 && s.ms > 0 && s.fuelMs >= s.ms * 0.9 ? s.fuel * 100 / s.km : null;
    const drawDashboard = (s, rows) => {
        panel(20, 56, 900, 214, 'Средний расход');
        txt(fmt(fuelAvg(s), 1) + ' л/100 км', 38, 149, 54);
        panel(940, 56, 640, 214, 'Пробег');
        txt(fmt(s.km, 1) + ' км', 958, 167, 65);
        line(1220, 104, 1220, 241);
        [['Eco Pro','eco'],['Comfort','comfort'],['Sport','sport']].forEach(([label, k], i) => {
            txt(label, 1240, 122 + i * 45, 25, colors[k]);
            txt((s.km > s.modes.unknown ? fmt(s.modes[k], 1) : '—') + ' км', 1558, 122 + i * 45, 25, null, 'right');
        });
        panel(20, 285, 900, 210, 'Круиз Professional');
        txt(fmt(cruisePct(s), 0) + ' %', 38, 381, 54);
        txt(fmt(s.cruiseKnownKm ? s.cruiseKm : null, 1) + ' км', 897, 365, 30, null, 'right');
        panel(940, 285, 309, 210, 'Старт-стоп');
        const sec = Math.floor(s.stopped / 1000);
        txt(s.stoppedKnown ? Math.floor(sec / 60) + ' мин ' + sec % 60 + ' с' : '—', 960, 411, 47);
        panel(1270, 285, 310, 210, 'Средняя скорость');
        txt(fmt(s.ms ? s.km * 3600000 / s.ms : null, 0) + ' км/ч', 1290, 411, 49);
        if (!rows || !rows.length) return;
        const samples = rows.filter((r) => r.type === 'sample');
        const x = (at) => 42 + 850 * (at - s.start) / Math.max(1, s.end - s.start);
        const fy = (r) => 253 - Math.min(40, 100 * r.lph / r.speed) * 2.2;
        for (let i = 1; i < samples.length; i++) {
            const p = samples[i - 1], q = samples[i];
            if (q.at - p.at > 3000 || !Number.isFinite(p.lph) || !Number.isFinite(q.lph) || !(p.speed >= 5 && q.speed >= 5)) continue;
            const c = colors[p.mode] || '#687382';
            const pts = [[x(p.at), fy(p)], [x(q.at), fy(q)]];
            cv.fillUnder(pts, 254, c);
            cv.polyline(pts, 2, '#f5f5f5');
        }
        const steps = cruiseSteps(samples, 3000);
        line(42, 462, 892, 462);
        if (!steps.length) txt('Заданная скорость — нет данных', 42, 435, 22, '#b5bfcc');
        for (const step of steps) {
            const h = Math.min(step.kmh, 160) * 0.52;
            cv.fillRect(x(step.start), 462 - h, x(step.end) - x(step.start), h, '#15445e');
            line(x(step.start), 462 - h, x(step.end), 462 - h, '#37cce8');
            if (x(step.end) - x(step.start) >= 48) txt(String(step.kmh), x(step.start) + 6, 457 - h, 18, '#6de4ff');
        }
        [0, 0.5, 1].forEach((f) => txt(clock(s.start + (s.end - s.start) * f), 42 + 850 * f, 486, 18, '#bdc7d5', f === 0 ? 'left' : f === 1 ? 'right' : 'center'));
    };

    if (state.tab === 0 || state.tab === 1) {
        const history = journal.history.slice().reverse();
        const entry = state.tab === 0 ? journal.entries().slice(-1)[0] : history[state.selected];
        if (entry && (state.tab === 0 || state.selected !== null)) drawDashboard(entry.summary, journal.rows(entry));
        else if (state.tab === 0) txt('Поездки появятся после начала движения', 40, 122, 35);
        else {
            panel(20, 56, 1560, 439, 'История поездок');
            history.slice(state.offset * 6, state.offset * 6 + 6).forEach((entry, i) => {
                const s = entry.summary;
                button(day(s.start) + '   ·   ' + fmt(s.km, 1) + ' км   ·   ' + fmt(fuelAvg(s), 1) + ' л/100 км   ·   Professional ' + fmt(cruisePct(s), 0) + ' %',
                    42, 111 + i * 54, 1200, () => a.history(state.offset * 6 + i));
            });
            if (!history.length) txt('История пока пуста', 42, 145, 28);
            if (history.length > 6) button('Далее', 1300, 111, 230, a.more);
        }
    } else if (state.tab <= 4) {
        drawDashboard(journal.counter(state.tab - 2), null);
        button(state.confirm ? 'Подтвердить сброс ' + tabs[state.tab] : 'Сбросить ' + tabs[state.tab],
            1000, 425, 500, a.reset, state.confirm);
        const reset = journal.resets[state.tab - 2];
        txt(state.message || (reset ? 'С ' + day(reset) : 'За всю историю'), 42, 243, 22, '#b5bfcc');
    } else {
        panel(20, 56, 800, 439, state.tab === 5 ? 'Поездки для выгрузки' : 'Диагностика круиза');
        panel(840, 56, 740, 439, 'Скачать на телефон');
        if (state.tab === 5) {
            ['Последняя поездка','Период','Вся история'].forEach((label, i) => button(label, 43, 115 + i * 57, 740,
                () => a.exportOption(i), state.option === i));
            if (state.option === 1) button('Последние ' + state.days + ' дн.  ›', 43, 288, 740, a.days);
            button('Подготовить ZIP', 43, 350, 740, () => a.prepare(false));
            txt('CSV + JSONL', 43, 438, 23, '#bdc7d5');
        } else {
            txt('BimmerLink   3584 · 520 · 521 · 776', 43, 151, 28);
            txt('Поиск кандидатов в каталоге MGU', 43, 207, 25);
            if (state.report) txt('Совпадений: ' + state.report.candidates.length, 43, 255, 25);
            button('Сформировать отчёт', 43, 350, 740, () => a.prepare(true));
        }
        if (state.transfer) {
            if (state.transfer.url !== cachedUrl) {
                cachedUrl = state.transfer.url;
                cachedQr = qrCode(0, 'M'); cachedQr.addData(cachedUrl); cachedQr.make();
            }
            const n = cachedQr.getModuleCount(), size = Math.floor(240 / (n + 8));
            const left = 1210 - (n + 8) * size / 2, top = 109;
            cv.fillRect(left, top, (n + 8) * size, (n + 8) * size, '#ffffff');
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                if (cachedQr.isDark(y, x)) cv.fillRect(left + (x + 4) * size, top + (y + 4) * size, size, size, '#000000');
            }
            txt('Подключись к Wi-Fi BMW', 1210, 399, 25, null, 'center');
            txt('Отсканируй QR-код', 1210, 434, 25, null, 'center');
        } else {
            txt(state.message || 'QR-код появится после подготовки', 870, 159, 24, '#bdc7d5');
        }
    }
}
module.exports = { draw, tabs };
