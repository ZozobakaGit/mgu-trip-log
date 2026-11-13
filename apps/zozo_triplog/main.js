'use strict';
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const Fuel = require('./fuel');
const { Journal } = require('./journal');
const { scan } = require('./diagnostics');
const { archive, serve } = require('./export');
const { draw, tabs } = require('./screen');

const CDS = 'de.bmw.infotainment.vehicle.CDS';
const CDS2 = CDS + '2';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const modeOf = (raw) => {
    const n = Number(raw);
    if (/^SPORT/.test(raw) || (n >= 1 && n <= 3)) return 'sport';
    if (/^COMFORT/.test(raw) || (n >= 4 && n <= 6)) return 'comfort';
    if (/^ECO_PRO/.test(raw) || (n >= 7 && n <= 9)) return 'eco';
    if (raw === 'ADAPTIVE' || n === 10) return 'other';
    return null;
};
const engineOf = (raw) => ({ MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running',
    0: 'off', 1: 'starting', 2: 'running' })[raw] || null;

mgu.run({
    async start(ctx) {
        const { log, ui } = ctx;
        const guard = (fn) => function () {
            try { return fn.apply(null, arguments); } catch (e) { log.warn(e.stack || e.message); }
        };
        const journal = new Journal(ctx.dataDir);
        const car = new Car(ctx, ['speed', 'rpm', 'gear'], { demo: false });
        const watch = (iface, fields) => Promise.resolve(ctx.signals.watch(iface, '1', fields, log, { read: true }))
            .catch((e) => log.warn(e.message));
        let mode = null, engine = null, msa = null;
        watch(FES, { statusFESVehicleDynamicSwitchHMI: (v) => { mode = modeOf(v.actualValueModeDrivingExperience); } });
        watch(CDS, { statusEngineStatus: (v) => { engine = engineOf(v.statusEngineRunDrive); } });
        watch(CDS2, { statusPushButtonMSA2: (v) => {
            const r = v.statusFunctionMSA;
            msa = r === 1 || r === 'MSA_AKTIVIERT' ? true : r === 0 || r === 'MSA_DEAKTIVIERT' ? false : null;
        } });
        const link = new ReadOnlyDiag(ctx.signals, log);
        const fuel = new Fuel(ctx, () => link, { diesel: false });
        link.init().catch((e) => log.warn(e.message));
        let stopped = false, runningAt = 0, fuelOn = false;
        const speedIface = 'de.bmw.infotainment.vehicle.Vehicle2';
        const tick = guard(() => {
            const at = Date.now(), d = car.data();
            const speedSub = car.subBy[speedIface];
            const speed = speedSub && speedSub.available && Number.isFinite(d.speed) ? d.speed : null;
            if (speed === null && journal.last && at - journal.last.at > 120000) journal.end(journal.last.at);
            if (speed === null) { if (fuelOn) fuel.stop(); fuelOn = false; return; }
            if (engine === 'running') { runningAt = at; stopped = false; }
            if (engine === 'off' && d.stage === 'D' && speed !== null && speed < 1 && msa && runningAt) stopped = true;
            if (d.stage === 'P' || !msa || speed >= 1 || engine !== 'off') stopped = false;
            const want = !!(engine === 'running' && (journal.active || speed >= 2));
            if (want !== fuelOn) { fuelOn = want; if (want) fuel.start(); else fuel.stop(); }
            journal.sample(at, { speed, rpm: Number.isFinite(d.rpm) ? d.rpm : null, stage: d.stage || null,
                mode, engine, startStop: msa === null || !engine || !d.stage ? null : stopped,
                lph: engine === 'off' ? 0 : fuel.value().lph,
                cruise: null, cruiseRaw: null, setKmh: null });
        });
        setInterval(tick, 1000);
        setInterval(guard(() => journal.flush()), 10000);
        process.once('exit', guard(() => { if (journal.last) journal.end(journal.last.at); }));

        const state = { tab: 0, offset: 0, selected: null, option: 0, days: 7, transfer: null, message: '', report: null, confirm: false };
        function stopTransfer() {
            if (state.transfer) state.transfer.close();
            state.transfer = null;
        }
        function select(i) {
            stopTransfer();
            state.tab = i; state.offset = 0; state.selected = null; state.confirm = false; state.message = '';
        }
        function diagnose() {
            state.report = scan(journal.dir);
            state.message = state.report.error ? 'Каталог недоступен' : 'Отчёт сохранён';
        }
        let busy = false;
        async function prepare(only) {
            if (busy) return;
            busy = true;
            stopTransfer();
            const tab = state.tab;
            try {
                if (only) diagnose();
                journal.flush();
                let entries = journal.entries().slice();
                if (state.option === 0) entries = journal.history.slice(-1);
                if (state.option === 1) entries = entries.filter((e) => e.summary.end >= Date.now() - state.days * 86400000);
                if (!only && !entries.length) { state.message = 'За этот период нет поездок'; return; }
                state.message = 'Готовлю архив…';
                const data = archive(journal, entries, only);
                let current;
                current = await serve(() => data, () => { if (state.transfer === current) state.transfer = null; });
                if (state.tab !== tab) { current.close(); return; }
                state.transfer = current;
                state.message = '';
            } catch (e) { state.message = e.message; }
            finally { busy = false; }
        }
        const actions = {
            select, prepare,
            exportOption(i) { stopTransfer(); state.option = i; state.message = ''; },
            days() { stopTransfer(); const opts = [1, 7, 30, 90]; state.days = opts[(opts.indexOf(state.days) + 1) % opts.length]; state.message = ''; },
            history(i) { state.selected = i; },
            more() { state.offset = (state.offset + 1) % Math.max(1, Math.ceil(journal.history.length / 6)); state.selected = null; },
            reset() {
                if (!state.confirm) { state.confirm = true; return; }
                journal.reset(state.tab - 2, Date.now()); state.confirm = false; state.message = 'Счётчик сброшен';
            }
        };
        ctx.onTab(select);
        ctx.onBack(() => {
            if (state.tab === 1 && state.selected !== null) { state.selected = null; return true; }
            if (state.confirm) { state.confirm = false; return true; }
            return false;
        });
        ui.onClick('BTN_NEXT', () => select((state.tab + 1) % tabs.length));
        ui.onClick('BTN_MORE', () => {
            if (state.tab === 1) actions.more();
            else if (state.tab === 5) actions.exportOption((state.option + 1) % 3);
        });
        ui.onClick('BTN_ACTION', () => {
            if (state.tab === 1) state.selected = state.selected === null ? state.offset * 6 : state.selected + 1;
            if (state.tab >= 2 && state.tab <= 4) actions.reset();
            if (state.tab === 5 || state.tab === 6) return prepare(state.tab === 6);
        });
        ctx.loop('MAIN', 2, async () => {
            const theme = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear('#090b10');
            G.frame(cv, theme, tabs, state.tab);
            draw(cv, journal, state, actions);
            await ui.image('MAIN_GFX', cv);
        });
    }
});
