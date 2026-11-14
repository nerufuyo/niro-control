// The action registry: one typed list of what Niro can do (open an app, lock the screen, apply a profile…), shared by the
// application search, the keyboard shortcuts and anything that asks over D-Bus (the voice assistant included). Pure: no GNOME
// imports, so it is tested with node. Handlers get an `env` (what the shell offers) and may refuse when it can't be done.

export type ParamType = 'string' | 'number' | 'boolean' | 'enum';
export interface Param {
    name: string;
    type: ParamType;
    required?: boolean;
    enum?: string[];
    min?: number;
    max?: number;
    maxLength?: number;
}

/** none: runs at once. confirm: asks first (it ends a session or closes things). Anything asked from outside the search panel
 * (D-Bus, a shortcut) asks for every action that is not `none`. */
export type Permission = 'none' | 'confirm';
export type Source = 'ui' | 'external';

export interface Action<Env = unknown> {
    id: string;
    title: string;
    description: string;
    category: string;
    keywords: string[];
    params?: Param[];
    permission: Permission;
    confirm?: string;                                   // the question asked before running, when permission is not none
    available?: (env: Env) => string | null;            // why it can't run now, or null
    run: (args: Record<string, unknown>, env: Env) => Promise<string | void>;
}

export type Code = 'unknown' | 'invalid' | 'unavailable' | 'declined' | 'failed';
export interface Outcome {ok: boolean; message?: string; error?: string; code?: Code}

/** What is wrong with `args` for `params`, or null. Unknown arguments are refused too: nothing slips in unchecked. */
export function validateArgs(params: Param[] = [], args: Record<string, unknown> = {}): string | null {
    for (const key of Object.keys(args))
        if (!params.some(p => p.name === key)) return `unknown argument "${key}"`;
    for (const p of params) {
        const v = args[p.name];
        if (v === undefined || v === null) {
            if (p.required) return `"${p.name}" is required`;
            continue;
        }
        switch (p.type) {
        case 'string':
            if (typeof v !== 'string') return `"${p.name}" must be text`;
            if (v.length > (p.maxLength ?? 2000)) return `"${p.name}" is too long`;
            break;
        case 'number':
            if (typeof v !== 'number' || !Number.isFinite(v)) return `"${p.name}" must be a number`;
            if (p.min !== undefined && v < p.min) return `"${p.name}" must be at least ${p.min}`;
            if (p.max !== undefined && v > p.max) return `"${p.name}" must be at most ${p.max}`;
            break;
        case 'boolean':
            if (typeof v !== 'boolean') return `"${p.name}" must be true or false`;
            break;
        case 'enum':
            if (typeof v !== 'string' || !(p.enum ?? []).includes(v)) return `"${p.name}" must be one of ${(p.enum ?? []).join(', ')}`;
            break;
        }
    }
    return null;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

export class Registry<Env = unknown> {
    private actions = new Map<string, Action<Env>>();

    register(action: Action<Env>): this {
        if (!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(action.id)) throw new Error(`bad action id "${action.id}"`);
        if (this.actions.has(action.id)) throw new Error(`action "${action.id}" is registered twice`);
        if (action.permission !== 'none' && !action.confirm) throw new Error(`action "${action.id}" needs a confirmation question`);
        this.actions.set(action.id, action);
        return this;
    }

    get(id: string) { return this.actions.get(id); }
    list(): Action<Env>[] { return [...this.actions.values()]; }

    /** Actions matching `query`, best first: a title start beats a title word beats a keyword beats the description. */
    find(query: string, env?: Env, limit = 6): Action<Env>[] {
        const words = norm(query).split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const scored: [number, number, Action<Env>][] = [];
        this.list().forEach((a, order) => {
            if (env && a.available?.(env)) return;
            const title = norm(a.title), keys = a.keywords.map(norm), desc = norm(a.description);
            let score = 0, hit = 0;
            for (const w of words) {
                if (title.startsWith(w)) score += 5;
                else if (title.split(/\s+/).some(t => t.startsWith(w))) score += 4;
                else if (title.includes(w)) score += 3;
                else if (keys.some(k => k.startsWith(w))) score += 3;
                else if (keys.some(k => k.includes(w))) score += 2;
                else if (desc.includes(w)) score += 1;
                else return;
                hit++;
            }
            if (hit === words.length) scored.push([score, order, a]);
        });
        return scored.sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, limit).map(s => s[2]);
    }

    /** Runs an action: validates, checks it can run, asks when it must, and never throws: the outcome says what happened. */
    async run(id: string, args: Record<string, unknown>, env: Env, source: Source, ask: (a: Action<Env>, args: Record<string, unknown>) => Promise<boolean>): Promise<Outcome> {
        const action = this.actions.get(id);
        if (!action) return {ok: false, code: 'unknown', error: `no action "${id}"`};
        const bad = validateArgs(action.params, args);
        if (bad) return {ok: false, code: 'invalid', error: bad};
        const why = action.available?.(env);
        if (why) return {ok: false, code: 'unavailable', error: why};
        if (action.permission !== 'none') {
            let yes = false;
            try { yes = await ask(action, args); } catch (_e) { yes = false; }
            if (!yes) return {ok: false, code: 'declined', error: 'cancelled'};
        }
        void source;
        try {
            const message = await action.run(args, env);
            return {ok: true, message: (message as string | undefined) ?? action.title};
        } catch (e) {
            return {ok: false, code: 'failed', error: (e as Error).message ?? String(e)};
        }
    }

    /** What an outside caller may see of the registry: no handlers. */
    manifest() {
        return this.list().map(a => ({id: a.id, title: a.title, description: a.description, category: a.category, keywords: a.keywords,
            params: a.params ?? [], permission: a.permission}));
    }
}
