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
export const forecastUrl = (p: Place): string => `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3`;

const WMO: Record<number, string> = {0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
    82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail'};
export const sky = (code: number): string => WMO[code] ?? 'unknown';

/** Lines for the rows: now, then each day. */
export function describe(json: any, place: Place): string[] {
    const c = json?.current, d = json?.daily;
    if (!c || !d?.time) return [];
    const lines = [`${place.name}${place.country ? `, ${place.country}` : ''}: ${Math.round(c.temperature_2m)}°C, ${sky(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)} km/h`];
    d.time.forEach((day: string, i: number) => lines.push(`${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : day}: ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C, ${sky(d.weather_code[i])}, rain ${d.precipitation_probability_max[i] ?? 0}%`));
    return lines;
}

export const WORLD_CITIES = ['jakarta', 'tokyo', 'london', 'new york', 'sydney'];
export const worldQuery = (query: string): boolean => /^(?:world|clocks?|jam dunia|world clock)$/i.test(query.trim());
