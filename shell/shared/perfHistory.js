// Performance Center core (vNext S25). Pure: a fixed-size history, an adaptive sampling interval (slow when nobody is looking),
// and a diagnostic export that carries numbers only: no environment, no command lines, nothing that could hold a credential.

export function createHistory(capacity = 360) {
    const samples = [];
    return {
        push(s) {
            samples.push(s);
            if (samples.length > capacity)
                samples.shift();
        },
        samples: () => samples.slice(),
        last: () => samples[samples.length - 1] ?? null,
        clear: () => { samples.length = 0; },
        average(key, n = samples.length) {
            const v = samples.slice(-n).map(s => s[key]).filter(Number.isFinite);
            return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        },
        capacity: () => capacity,
    };
}

/** Milliseconds until the next sample: none while hidden and not recording, slow on battery, quick only while the dashboard is open and busy. */
export function nextInterval({visible, recording, onBattery, load}) {
    if (!visible && !recording)
        return null;                       // no polling at all
    if (!visible)
        return onBattery ? 60000 : 30000;  // background history
    if (load > 0.8)
        return 1000;
    return onBattery ? 4000 : 2000;
}

const NUM_KEYS = ['cpu', 'memUsed', 'memTotal', 'swapUsed', 'diskUsed', 'diskTotal', 'netRx', 'netTx', 'battery', 'temp', 'load1'];

/** A report of numbers only; a sensor that is not there is listed as unavailable, not as zero. */
export function exportDiagnostics(history, {appVersion = 'unknown', shellVersion = 'unknown', now = () => new Date().toISOString()} = {}) {
    const last = history.last() ?? {};
    return {
        generatedAt: now(), appVersion, shellVersion, samples: history.samples().length,
        latest: Object.fromEntries(NUM_KEYS.filter(k => Number.isFinite(last[k])).map(k => [k, last[k]])),
        unavailable: NUM_KEYS.filter(k => !Number.isFinite(last[k])),
        averages: Object.fromEntries(NUM_KEYS.map(k => [k, history.average(k)]).filter(([, v]) => v !== null)),
    };
}

/** Resource use per process, trimmed to name and numbers, top `n` by CPU. Command lines are dropped on purpose (they can carry secrets). */
export function topProcesses(procs, n = 5) {
    return procs.map(p => ({name: String(p.name ?? '').slice(0, 40), pid: p.pid, cpu: p.cpu, mem: p.mem}))
        .sort((a, b) => b.cpu - a.cpu).slice(0, n);
}
