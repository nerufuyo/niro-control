// The calculator: arithmetic typed into the search. A small recursive-descent parser (never eval), so only numbers,
// + - * / % ^, brackets, a few functions and "X% of Y" are understood, and anything else is not a calculation.

const FUNCS: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10,
    exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil,
};
const CONSTS: Record<string, number> = {pi: Math.PI, e: Math.E};

type Tok = {t: 'num'; v: number} | {t: 'op'; v: string} | {t: 'id'; v: string};

function tokenize(src: string): Tok[] | null {
    const out: Tok[] = [];
    const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^').replace(/(\d),(?=\d{3}\b)/g, '$1');
    for (let i = 0; i < s.length;) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
        if (num) { out.push({t: 'num', v: parseFloat(num[0])}); i += num[0].length; continue; }
        const id = /^[a-z]+/i.exec(s.slice(i));
        if (id) { out.push(id[0].toLowerCase() === 'x' ? {t: 'op', v: '*'} : {t: 'id', v: id[0].toLowerCase()}); i += id[0].length; continue; }
        if ('+-*/%^()x'.includes(c)) { out.push({t: 'op', v: c === 'x' ? '*' : c}); i++; continue; }
        return null;
    }
    return out;
}

class Parser {
    i = 0;
    constructor(private toks: Tok[]) {}
    private peek() { return this.toks[this.i]; }
    private isOp(v: string) { const t = this.peek(); return t?.t === 'op' && t.v === v; }
    private isWord(v: string) { const t = this.peek(); return t?.t === 'id' && t.v === v; }
    done() { return this.i >= this.toks.length; }

    pctAt = -1;   // where the parser stood right after a bare percentage like 10%: "100 + 10%" means 110

    expr(): number {
        let v = this.term();
        for (;;) {
            const plus = this.isOp('+'), minus = this.isOp('-');
            if (!plus && !minus) return v;
            this.i++;
            const r = this.term();
            const amount = this.pctAt === this.i ? v * r : r;
            v = plus ? v + amount : v - amount;
        }
    }

    term(): number {
        let v = this.power();
        for (;;) {
            if (this.isOp('*')) { this.i++; v *= this.power(); }
            else if (this.isOp('/')) { this.i++; const d = this.power(); if (d === 0) throw new Error('division by zero'); v /= d; }
            else if (this.isOp('%') && this.startsOperand(this.toks[this.i + 1])) { this.i++; const d = this.power(); if (d === 0) throw new Error('division by zero'); v %= d; }
            else return v;
        }
    }

    /** Whether `t` can begin an operand (so a % before it is "remainder", not "percent"). */
    private startsOperand(t?: Tok) { return t?.t === 'num' || (t?.t === 'op' && (t.v === '(' || t.v === '-')) || (t?.t === 'id' && t.v !== 'of'); }

    power(): number {
        const base = this.unary();
        if (this.isOp('^')) { this.i++; return Math.pow(base, this.power()); }
        return base;
    }

    unary(): number {
        if (this.isOp('-')) { this.i++; return -this.unary(); }
        if (this.isOp('+')) { this.i++; return this.unary(); }
        return this.atom();
    }

    atom(): number {
        const t = this.peek();
        if (!t) throw new Error('unexpected end');
        if (t.t === 'num') {
            this.i++;
            if (this.isOp('%') && !this.startsOperand(this.toks[this.i + 1])) {
                this.i++;
                const v = t.v / 100;
                if (this.isWord('of')) { this.i++; return v * this.power(); }
                this.pctAt = this.i;
                return v;
            }
            return t.v;
        }
        if (t.t === 'id') {
            this.i++;
            if (t.v in CONSTS) return CONSTS[t.v];
            const f = FUNCS[t.v];
            if (!f) throw new Error(`unknown "${t.v}"`);
            if (!this.isOp('(')) throw new Error(`${t.v} needs brackets`);
            this.i++; const v = this.expr();
            if (!this.isOp(')')) throw new Error('missing )');
            this.i++;
            return f(v);
        }
        if (t.v === '(') {
            this.i++; const v = this.expr();
            if (!this.isOp(')')) throw new Error('missing )');
            this.i++;
            return v;
        }
        throw new Error(`unexpected ${t.v}`);
    }
}

/** 1234.5 as "1,234.5" (at most 10 significant digits, no trailing zeros). */
export function formatNumber(n: number): string {
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)) return n.toExponential(6).replace(/\.?0+e/, 'e');
    const s = Number(n.toPrecision(10)).toString();
    const [int, frac] = s.split('.');
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}

export interface Calc {value: number; text: string}

/** The result when `query` is a calculation (it needs an operator, a function or a percentage: a lone number is not one). */
export function calculate(query: string): Calc | null {
    const q = query.trim().replace(/=\s*$/, '');
    if (!q || q.length > 120 || !/\d/.test(q)) return null;
    if (!/[-+*/%^×÷−]|\*\*|\b(?:sqrt|abs|sin|cos|tan|ln|log|exp|round|floor|ceil|of)\b|\dx\d|\d\s+x\s+\d/i.test(q)) return null;
    const toks = tokenize(q);
    if (!toks) return null;
    try {
        const p = new Parser(toks);
        const value = p.expr();
        if (!p.done() || !Number.isFinite(value)) return null;
        return {value, text: formatNumber(value)};
    } catch (_e) {
        return null;
    }
}
