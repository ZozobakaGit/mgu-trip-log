'use strict';
const mgu = require('./kit/mgu');
const { frame } = require('./kit/gauges');
const { draw, tabs } = require('./screen');
const { summary } = require('./journal');

const DEMO_START = Date.UTC(2026, 0, 1, 8, 42);
const DEMO_ROWS = Array.from({ length: 181 }, (_, i) => {
    const mode = i < 36 ? 'eco' : i < 155 ? 'comfort' : 'sport';
    const cruise = i >= 45 && i < 122;
    return { type: 'sample', at: DEMO_START + i * 1000, mode, interval_mode: mode,
        speed: 67, lph: 6.1 + 1.4 * Math.sin(i / 9) + 0.8 * Math.cos(i / 3),
        dt: i ? 1000 : 0, km: 67 / 3600, liters: 6.1 / 3600, cruise, interval_cruise: cruise,
        setKmh: cruise ? i < 85 ? 80 : 100 : null, stopped_ms: i > 167 ? 1000 : 0, stopped_known_ms: 1000 };
});
const demo = { rows: DEMO_ROWS, summary: summary(DEMO_ROWS) };
const journal = { history: [demo], resets: [0,0,0], entries: () => [demo], rows: () => DEMO_ROWS, counter: () => demo.summary };

mgu.run({
    start(ctx) {
        const { ui, log } = ctx;
        const state = { tab: 0, offset: 0, selected: null, option: 0, days: 7, transfer: null, message: '' };
        let probe = null, lastReport = null, page = 0, scanResult = null, dirty = true, drawing = false;
        const specs = ctx.spec.probeProxies || {};
        const text = (cv, label, x, y, size, color) => cv.text(label, x, y, size, color || '#f5f6fa', { literal: true });
        const refresh = () => { dirty = true; };
        const stopTransfer = () => { if (state.transfer) state.transfer.close(); state.transfer = null; };
        const stopProbe = () => {
            if (!probe) return;
            const p = probe;
            probe = null;
            clearTimeout(p.timer);
            p.subs.forEach((sub) => sub.shutdown());
            p.report.ended = new Date().toISOString();
            lastReport = p.report;
            refresh();
        };
        const select = (i) => {
            stopProbe(); stopTransfer();
            state.tab = i; state.selected = null; state.message = ''; page = 0;
            refresh();
        };
        const startProbe = () => {
            if (!ui.isVisible('MAIN')) return;
            if (probe) { stopProbe(); return; }
            stopTransfer();
            state.message = '';
            try { scanResult = { candidates: require('./cruise-probe').scan(), error: null }; }
            catch (e) { scanResult = { candidates: [], error: e.message }; }
            const p = { subs: [], report: { started: new Date().toISOString(), catalog: scanResult, fields: [] } };
            lastReport = p.report;
            page = 0;
            if (!Object.keys(specs).length) { refresh(); return; }
            probe = p;
            p.timer = setTimeout(stopProbe, 120000);
            for (const iface of Object.keys(specs)) {
                const spec = specs[iface], handlers = {}, rows = [];
                for (const field of Object.keys(spec.attributes || {})) {
                    const row = { iface, instance: spec.instances, field, access: spec.attributes[field], count: 0, changes: 0, events: [] };
                    p.report.fields.push(row);
                    rows.push(row);
                    handlers[field] = (value) => {
                        if (probe !== p) return;
                        let raw;
                        try { raw = JSON.stringify(value); } catch (e) { raw = String(value); }
                        raw = String(raw).slice(0, 750);
                        row.count++;
                        if (raw !== row.raw) {
                            row.changes++;
                            row.raw = raw;
                            row.at = new Date().toISOString();
                            row.events.push({ at: row.at, raw });
                            if (row.events.length > 30) row.events.shift();
                        }
                        refresh();
                    };
                }
                if (!rows.length) continue;
                Promise.resolve(ctx.signals.watch(iface, spec.instances, handlers, log, { fieldAccess: spec.attributes }))
                    .then((sub) => {
                        if (probe !== p) return sub.shutdown();
                        p.subs.push(sub);
                        if (sub.error) rows.forEach((row) => { row.error = sub.error; });
                        refresh();
                    }).catch((e) => {
                        if (probe === p) rows.forEach((row) => { row.error = e.message; });
                        refresh();
                    });
            }
            refresh();
        };
        let preparing = false;
        async function exportReport() {
            if (preparing || !lastReport || !ui.isVisible('MAIN')) return;
            preparing = true;
            stopProbe(); stopTransfer();
            try {
                const { zip, serve } = require('./export');
                const report = JSON.stringify(lastReport, null, 2);
                let transfer;
                transfer = await serve(() => zip({ 'cruise-diagnostics.json': report }), () => {
                    if (state.transfer === transfer) state.transfer = null;
                    refresh();
                });
                if (state.tab !== 6 || !ui.isVisible('MAIN')) transfer.close();
                else state.transfer = transfer;
            } catch (e) { state.message = e.message; }
            finally { preparing = false; refresh(); }
        }

        const actions = {
            history(i) { state.selected = i; refresh(); }, more() {},
            reset() { state.message = 'Демо: счётчики не записываются'; refresh(); },
            exportOption(i) { state.option = i; refresh(); },
            days() { state.days = ({1:7,7:30,30:90,90:1})[state.days]; refresh(); },
            prepare() { state.message = 'Для живых данных открой «Диагностика»'; refresh(); }
        };

        ctx.onTab(select);
        ui.onVisible((name, shown) => {
            if (name !== 'MAIN') return;
            if (!shown) { stopProbe(); stopTransfer(); }
            refresh();
        });
        ctx.onLayout(refresh);
        ctx.onBack(() => {
            if (state.tab === 1 && state.selected !== null) { state.selected = null; refresh(); return true; }
            if (state.transfer) { stopTransfer(); refresh(); return true; }
            if (probe) { stopProbe(); return true; }
            return false;
        });
        ui.onClick('BTN_NEXT', () => select((state.tab + 1) % tabs.length));
        ui.onClick('BTN_ACTION', () => {
            if (state.tab === 6) startProbe();
            if (state.tab === 1) actions.history(0);
            if (state.tab >= 2 && state.tab <= 4) actions.reset();
            if (state.tab === 5) actions.prepare();
        });
        ui.onClick('BTN_MORE', () => {
            if (state.tab === 6) { page++; refresh(); }
            if (state.tab === 5) actions.exportOption((state.option + 1) % 3);
        });
        ui.onClick('BTN_EXPORT', () => { if (state.tab === 6) return exportReport(); });

        function diagnostic(cv) {
            const target = (label, x, w, action) => {
                cv.fillRect(x, 439, w, 49, '#222a39');
                text(cv, label, x + 12, 471, 26);
                if (cv.target) cv.target(x, 439, w, 49, action, label, 4);
            };
            text(cv, 'Круиз Professional · диагностика', 30, 96, 38);
            if (state.transfer) {
                const qr = require('./qrcode')(0, 'M');
                qr.addData(state.transfer.url); qr.make();
                const n = qr.getModuleCount(), size = 7;
                cv.fillRect(1110, 102, (n + 8) * size, (n + 8) * size, '#ffffff');
                for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                    if (qr.isDark(y, x)) cv.fillRect(1110 + (x + 4) * size, 102 + (y + 4) * size, size, size, '#000000');
                }
                text(cv, 'Подключись к Wi-Fi BMW и отсканируй QR', 30, 165, 31);
                target('Закрыть QR', 30, 340, () => { stopTransfer(); refresh(); });
                return;
            }
            const fields = lastReport ? lastReport.fields : [];
            const count = scanResult ? scanResult.candidates.length : 0;
            const status = state.message || (scanResult && scanResult.error ? 'Каталог недоступен: ' + scanResult.error.slice(0, 85) :
                lastReport ? 'Кандидатов: ' + count + '  ·  Подписок: ' + fields.length + '  ·  Ответили: ' + fields.filter((r) => r.count).length :
                'Нажми «Проверить», чтобы прочитать сигналы с MGU.');
            text(cv, status, 30, 147, 27, '#b8c8db');
            if (fields.length) {
                const pages = Math.ceil(fields.length / 3);
                fields.slice((page % pages) * 3, (page % pages) * 3 + 3).forEach((row, i) => {
                    const y = 199 + i * 70;
                    text(cv, row.field.slice(0, 68) + '   ·   Ответов: ' + row.count + '   ·   Значений: ' + row.changes, 30, y, 26);
                    text(cv, (row.raw || row.error || 'Ожидание данных').slice(0, 105), 30, y + 30, 24, '#67d5ee');
                });
            } else if (lastReport) {
                text(cv, 'Нет доступных полей для чтения. Скачай отчёт с кандидатами.', 30, 221, 25);
            }
            target(probe ? 'Остановить' : 'Проверить', 30, 315, startProbe);
            if (fields.length > 3) target('Следующие поля', 365, 330, () => { page++; refresh(); });
            if (lastReport) target('QR отчёта', 715, 310, exportReport);
            if (probe) text(cv, 'Чтение до 2 минут', 1070, 471, 25, '#67d5ee');
        }

        ctx.loop('MAIN', 2, async () => {
            if (!dirty || drawing) return;
            drawing = true; dirty = false;
            try {
                const cv = ctx.canvas(1600, 520).clear('#090b10');
                frame(cv, ctx.theme(), tabs, state.tab);
                if (state.tab === 6) diagnostic(cv);
                else {
                    draw(cv, journal, state, actions);
                    text(cv, 'ДЕМО', 1460, 40, 27, '#f4bd6a');
                }
                await ui.image('MAIN_GFX', cv);
            } finally { drawing = false; }
        });
    }
});
