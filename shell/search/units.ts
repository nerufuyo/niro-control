// Unit conversion: "20 GB to MB", "5 km in miles", "72 f to c". Each kind has a base unit and a factor to it;
// temperature is the one kind that needs a formula.
import {formatNumber} from './calc.js';

type Unit = {names: string[]; label: string; factor: number};
const U = (label: string, factor: number, ...names: string[]): Unit => ({label, factor, names: [label.toLowerCase(), ...names]});

const KINDS: Record<string, Unit[]> = {
    length: [U('mm', 0.001, 'millimeter', 'millimeters', 'millimetre', 'millimetres'), U('cm', 0.01, 'centimeter', 'centimeters', 'centimetre', 'centimetres'),
        U('m', 1, 'meter', 'meters', 'metre', 'metres'), U('km', 1000, 'kilometer', 'kilometers', 'kilometre', 'kilometres'),
        U('in', 0.0254, 'inch', 'inches', '"'), U('ft', 0.3048, 'foot', 'feet', "'"), U('yd', 0.9144, 'yard', 'yards'),
        U('mi', 1609.344, 'mile', 'miles'), U('nmi', 1852, 'nautical mile', 'nm')],
    mass: [U('mg', 0.000001, 'milligram', 'milligrams'), U('g', 0.001, 'gram', 'grams'), U('kg', 1, 'kilogram', 'kilograms', 'kilo', 'kilos'),
        U('t', 1000, 'tonne', 'tonnes', 'ton'), U('lb', 0.45359237, 'lbs', 'pound', 'pounds'), U('oz', 0.028349523125, 'ounce', 'ounces')],
    data: [U('B', 1, 'byte', 'bytes'), U('KB', 1e3, 'kilobyte', 'kilobytes'), U('MB', 1e6, 'megabyte', 'megabytes'), U('GB', 1e9, 'gigabyte', 'gigabytes'),
        U('TB', 1e12, 'terabyte', 'terabytes'), U('KiB', 1024, 'kibibyte'), U('MiB', 1024 ** 2, 'mebibyte'), U('GiB', 1024 ** 3, 'gibibyte'),
        U('TiB', 1024 ** 4, 'tebibyte'), U('bit', 0.125, 'bits')],
    time: [U('ms', 0.001, 'millisecond', 'milliseconds'), U('s', 1, 'sec', 'secs', 'second', 'seconds'), U('min', 60, 'mins', 'minute', 'minutes'),
        U('h', 3600, 'hr', 'hrs', 'hour', 'hours'), U('day', 86400, 'days', 'd'), U('week', 604800, 'weeks', 'w')],
    speed: [U('m/s', 1, 'mps'), U('km/h', 1 / 3.6, 'kmh', 'kph', 'kmph'), U('mph', 0.44704, 'mi/h'), U('kn', 0.514444, 'knot', 'knots')],
    volume: [U('ml', 0.001, 'milliliter', 'milliliters', 'millilitre'), U('l', 1, 'liter', 'liters', 'litre', 'litres'), U('gal', 3.785411784, 'gallon', 'gallons'),
        U('qt', 0.946352946, 'quart', 'quarts'), U('pt', 0.473176473, 'pint', 'pints'), U('cup', 0.2365882365, 'cups'), U('floz', 0.0295735295625, 'fl oz')],
};
const TEMPS: Record<string, string> = {c: 'C', celsius: 'C', '°c': 'C', f: 'F', fahrenheit: 'F', '°f': 'F', k: 'K', kelvin: 'K'};

const lookup = new Map<string, {kind: string; unit: Unit}>();
for (const [kind, units] of Object.entries(KINDS))
    for (const unit of units)
        for (const n of unit.names) if (!lookup.has(n.toLowerCase())) lookup.set(n.toLowerCase(), {kind, unit});
// KB / MB… are decimal in the table; lowercase "kb" is the same unit. "b" alone is a byte.

const toKelvin = (v: number, u: string) => u === 'C' ? v + 273.15 : u === 'F' ? (v - 32) * 5 / 9 + 273.15 : v;
const fromKelvin = (k: number, u: string) => u === 'C' ? k - 273.15 : u === 'F' ? (k - 273.15) * 9 / 5 + 32 : k;

export interface Conversion {value: number; from: string; to: string; text: string}

export function convert(query: string): Conversion | null {
    const m = /^\s*(-?\d[\d,]*\.?\d*|-?\.\d+)\s*([^\s\d].*?)\s+(?:to|in|into|as|->|=)\s+(.+?)\s*$/i.exec(query);
    if (!m) return null;
    const amount = parseFloat(m[1].replace(/,/g, ''));
    const a = m[2].toLowerCase().trim(), b = m[3].toLowerCase().trim();
    if (!Number.isFinite(amount)) return null;
    if (a in TEMPS && b in TEMPS) {
        const value = fromKelvin(toKelvin(amount, TEMPS[a]), TEMPS[b]);
        return {value, from: `°${TEMPS[a]}`.replace('°K', 'K'), to: `°${TEMPS[b]}`.replace('°K', 'K'), text: `${formatNumber(Math.round(value * 1e6) / 1e6)} ${`°${TEMPS[b]}`.replace('°K', 'K')}`};
    }
    const from = lookup.get(a), to = lookup.get(b);
    if (!from || !to || from.kind !== to.kind) return null;
    const value = amount * from.unit.factor / to.unit.factor;
    return {value, from: from.unit.label, to: to.unit.label, text: `${formatNumber(value)} ${to.unit.label}`};
}
