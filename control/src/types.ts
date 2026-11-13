// What the catalog says about one setting.
export type Kind = 'switch' | 'slider' | 'stepper' | 'select' | 'text' | 'textarea' | 'shortcut' | 'shortcuts' | 'list' | 'color' | 'dict';
export type Source = 'niro' | 'island' | 'dock' | 'blur' | 'corners';

export interface Item {
    id: string;
    menu: 'Look' | 'Island' | 'Dock' | 'Windows' | 'Search';
    group: string;
    title: string;
    help: string;
    detail: string;
    kind: Kind;
    source: Source;
    key: string;
    type: string;            // the GVariant type of the key
    default: string;
    unit: string;
    path?: string[];         // a field inside a dictionary setting
    options?: {value: string | number; label: string}[];
    min?: number;
    max?: number;
    step?: number;
    digits?: number;
    count?: number;          // shortcuts: how many
    fields?: string[];       // dict: the fields of each shadow
    keys?: string[];         // dict: the settings that hold them
    advanced?: boolean;
    managed?: string;        // written by Look: the id of the Look item that owns it
    depends?: {id: string; op: 'on' | 'off' | 'eq' | 'ne'; value?: string};
}
