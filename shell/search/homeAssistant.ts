// Home Assistant from Search ("ha light" lists lights, Enter toggles one): the server and the token are the person's own. The address is
// the setting `ha-url`; the token is read from ~/.config/niro-control/ha-token (never from a setting, so it is not in the settings database).

export function haQuery(query: string): string | null {
    const m = /^ha(?:\s+(.*))?$/i.exec(query.trim());
    return m ? (m[1] ?? '').trim().toLowerCase().slice(0, 40) : null;
}
export const validBase = (url: string): string | null => /^https?:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/.test(url.trim()) ? url.trim().replace(/\/+$/, '') : null;
export const validEntity = (id: string): boolean => /^(?:light|switch|fan|input_boolean|cover|scene|script|automation|media_player|climate)\.[a-z0-9_]{1,60}$/.test(id);
export interface Entity {id: string; name: string; state: string}
/** The switchable things from `GET /api/states`, those whose id or name contains `filter`. */
export function entities(json: any, filter: string, limit = 8): Entity[] {
    if (!Array.isArray(json)) return [];
    return json.filter(e => typeof e?.entity_id === 'string' && validEntity(e.entity_id))
        .map(e => ({id: e.entity_id as string, name: String(e.attributes?.friendly_name ?? e.entity_id), state: String(e.state)}))
        .filter(e => !filter || e.id.includes(filter) || e.name.toLowerCase().includes(filter)).slice(0, limit);
}
/** The service to call for an entity: scenes and scripts run, the rest toggle. */
export const serviceFor = (id: string): {domain: string; service: string} => {
    const domain = id.split('.')[0];
    return domain === 'scene' || domain === 'script' ? {domain, service: 'turn_on'} : domain === 'automation' ? {domain, service: 'trigger'} : domain === 'cover' ? {domain, service: 'toggle'} : {domain, service: 'toggle'};
};
