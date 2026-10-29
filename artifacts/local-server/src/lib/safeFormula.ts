// COPY of artifacts/api-server/src/lib/safeFormula.ts: keep the two identical
// (checked by api-server/src/lib/safeFormula.parity.test.ts).
/**
 * Safe evaluator for organizer-defined points formulas.
 *
 * Replaces Node's `vm`, which is not a security boundary: a formula like
 * `this.constructor.constructor("return process")()` escapes it. This is a
 * small recursive-descent parser over a fixed grammar, so a formula can only
 * do arithmetic on `position` and `riders`:
 *
 *   numbers, position, riders, Math.PI, Math.E
 *   Math.abs|ceil|floor|round|trunc|sign|sqrt|cbrt|log|log2|log10|exp|pow|min|max(…)
 *   unary + - !   binary ** * / % + -   < <= > >= == === != !==   && ||   cond ? a : b
 *
 * Anything else (property access, strings, calls to other names) is a syntax error.
 */

const MATH_FUNCS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
  sign: Math.sign, sqrt: Math.sqrt, cbrt: Math.cbrt, log: Math.log, log2: Math.log2,
  log10: Math.log10, exp: Math.exp, pow: Math.pow, min: Math.min, max: Math.max,
};
const MATH_CONSTS: Record<string, number> = { PI: Math.PI, E: Math.E };
const MAX_LENGTH = 500;
const MAX_DEPTH = 50;

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

const OPS = ["===", "!==", "**", "<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "?", ":", "(", ")", ",", "."];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find(o => src.startsWith(o, i));
    if (op) { out.push({ t: "op", v: op }); i += op.length; continue; }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private tokens: Token[], private vars: Record<string, number>) {}

  parse(): number {
    const v = this.ternary();
    if (this.pos < this.tokens.length) throw new Error("Unexpected input after expression");
    return v;
  }
  private peek(op?: string): boolean {
    const tok = this.tokens[this.pos];
    return !!tok && tok.t === "op" && (op === undefined || tok.v === op);
  }
  private eat(op: string): void {
    if (!this.peek(op)) throw new Error(`Expected "${op}"`);
    this.pos++;
  }
  private nest<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Error("Formula too deeply nested");
    try { return fn(); } finally { this.depth--; }
  }
  private ternary(): number {
    return this.nest(() => {
      const cond = this.or();
      if (!this.peek("?")) return cond;
      this.pos++;
      const a = this.ternary();
      this.eat(":");
      const b = this.ternary();
      return cond ? a : b;
    });
  }
  private binary(next: () => number, ops: string[], apply: (op: string, l: number, r: number) => number): number {
    let left = next();
    while (true) {
      const tok = this.tokens[this.pos];
      if (!tok || tok.t !== "op" || !ops.includes(tok.v)) return left;
      this.pos++;
      left = apply(tok.v, left, next());
    }
  }
  private or = (): number => this.binary(this.and, ["||"], (_o, l, r) => (l || r));
  private and = (): number => this.binary(this.equality, ["&&"], (_o, l, r) => (l && r));
  private equality = (): number => this.binary(this.compare, ["===", "!==", "==", "!="], (o, l, r) =>
    Number(o === "===" || o === "==" ? l === r : l !== r));
  private compare = (): number => this.binary(this.additive, ["<", "<=", ">", ">="], (o, l, r) =>
    Number(o === "<" ? l < r : o === "<=" ? l <= r : o === ">" ? l > r : l >= r));
  private additive = (): number => this.binary(this.multiplicative, ["+", "-"], (o, l, r) => (o === "+" ? l + r : l - r));
  private multiplicative = (): number => this.binary(this.unary, ["*", "/", "%"], (o, l, r) =>
    (o === "*" ? l * r : o === "/" ? l / r : l % r));
  private unary = (): number => this.nest(() => {
    if (this.peek("-")) { this.pos++; return -this.unary(); }
    if (this.peek("+")) { this.pos++; return +this.unary(); }
    if (this.peek("!")) { this.pos++; return Number(!this.unary()); }
    return this.power();
  });
  private power(): number {
    const base = this.primary();
    if (this.peek("**")) { this.pos++; return base ** this.unary(); }
    return base;
  }
  private primary(): number {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new Error("Unexpected end of formula");
    if (tok.t === "num") return tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const v = this.ternary();
      this.eat(")");
      return v;
    }
    if (tok.t === "id") {
      if (tok.v === "Math") {
        this.eat(".");
        const name = this.tokens[this.pos++];
        if (!name || name.t !== "id") throw new Error("Expected Math member");
        if (Object.prototype.hasOwnProperty.call(MATH_CONSTS, name.v)) return MATH_CONSTS[name.v];
        if (!Object.prototype.hasOwnProperty.call(MATH_FUNCS, name.v)) throw new Error(`Math.${name.v} is not allowed`);
        this.eat("(");
        const args: number[] = [];
        if (!this.peek(")")) {
          args.push(this.ternary());
          while (this.peek(",")) { this.pos++; args.push(this.ternary()); }
        }
        this.eat(")");
        return MATH_FUNCS[name.v](...args);
      }
      if (Object.prototype.hasOwnProperty.call(this.vars, tok.v)) return this.vars[tok.v];
      throw new Error(`Unknown name "${tok.v}"`);
    }
    throw new Error(`Unexpected "${tok.v}"`);
  }
}

/** Evaluate a formula; throws on syntax errors or disallowed names. */
export function evaluateFormula(formula: string, vars: { position: number; riders: number }): number {
  if (formula.length > MAX_LENGTH) throw new Error("Formula too long");
  return new Parser(tokenize(formula), vars).parse();
}

/** Points for one finisher: rounded, never negative, 0 on any error or non-finite result. */
export function formulaPoints(formula: string, position: number, riders: number): number {
  try {
    const result = evaluateFormula(formula, { position, riders });
    if (typeof result !== "number" || !Number.isFinite(result)) return 0;
    return Math.max(0, Math.round(result));
  } catch {
    return 0;
  }
}
