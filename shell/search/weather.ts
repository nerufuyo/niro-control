// Weather in Search ("weather bandung", "cuaca tokyo"): the city name goes to Open-Meteo to find the place and its forecast; nothing else is sent.

declare const encodeURIComponent: (s: string) => string;

export function weatherQuery(query: string): string | null {
    const m = /^(?:weather|cuaca|forecast)\s+([\p{L} .'-]{2,40})$/iu.exec(query.trim());
    return m ? m[1].trim() : null;
}
export const geocodeUrl = (city: string): string => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
export interface Place {name: string; country: string; lat: number; lon: number}
export function parsePlace(json: any): Place | null {
    const r = json?.results?.[0];
    return r && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) ? {name: String(r.name), country: String(r.country ?? ''), lat: r.latitude, lon: r.longitude} : null;
}
export const forecastUrl = (p: Place, days = 3): string => `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=${Math.min(7, Math.max(1, Math.round(days)))}`;

export type Lang = 'en' | 'id';

const WMO: Record<Lang, Record<number, string>> = {
    en: {0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
        61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
        82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail'},
    id: {0: 'cerah', 1: 'cerah berawan tipis', 2: 'berawan sebagian', 3: 'mendung', 45: 'berkabut', 48: 'berkabut', 51: 'gerimis ringan', 53: 'gerimis', 55: 'gerimis lebat',
        61: 'hujan ringan', 63: 'hujan', 65: 'hujan lebat', 66: 'hujan beku', 67: 'hujan beku', 71: 'salju ringan', 73: 'salju', 75: 'salju lebat', 77: 'butiran salju', 80: 'hujan sesaat ringan', 81: 'hujan sesaat',
        82: 'hujan sesaat lebat', 85: 'hujan salju', 86: 'hujan salju', 95: 'badai petir', 96: 'badai petir dengan es', 99: 'badai petir dengan es'},
};
const WORDS = {
    en: {today: 'Today', tomorrow: 'Tomorrow', wind: 'wind', rain: 'rain', unknown: 'unknown'},
    id: {today: 'Hari ini', tomorrow: 'Besok', wind: 'angin', rain: 'hujan', unknown: 'tidak diketahui'},
};
export const sky = (code: number, lang: Lang = 'en'): string => WMO[lang][code] ?? WORDS[lang].unknown;

/** Lines for the rows: now, then each day. */
export function describe(json: any, place: Place, lang: Lang = 'en'): string[] {
    const c = json?.current, d = json?.daily, w = WORDS[lang];
    if (!c || !d?.time) return [];
    const lines = [`${place.name}${place.country ? `, ${place.country}` : ''}: ${Math.round(c.temperature_2m)}°C, ${sky(c.weather_code, lang)}, ${w.wind} ${Math.round(c.wind_speed_10m)} km/h`];
    d.time.forEach((day: string, i: number) => lines.push(`${i === 0 ? w.today : i === 1 ? w.tomorrow : day}: ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C, ${sky(d.weather_code[i], lang)}, ${w.rain} ${d.precipitation_probability_max[i] ?? 0}%`));
    return lines;
}

export const WORLD_CITIES = ['jakarta', 'tokyo', 'london', 'new york', 'sydney'];
export const worldQuery = (query: string): boolean => /^(?:world|clocks?|jam dunia|world clock)$/i.test(query.trim());

/** The cities typed in the setting ("jakarta, tokyo, new york"): trimmed, lower-cased, no repeats, at most eight. */
export function parseCities(text: string, fallback: string[] = WORLD_CITIES): string[] {
    const list = [...new Set(text.split(',').map(c => c.trim().toLowerCase()).filter(Boolean))].slice(0, 8);
    return list.length ? list : fallback;
}
