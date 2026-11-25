/** A multi-file project with one type error and a node_modules package that ships only `.d.ts` types. */
export const PROJECT_ROOT = "/home/project";

export const MAIN_PATH = `${PROJECT_ROOT}/src/main.ts`;

export const MAIN_TEXT = `import { Vector, makePoint } from "./shapes";
import { formatMoney, ZERO } from "tiny-money";

const origin = makePoint(0, 0);
const step = new Vector(3, 4);
const label: string = formatMoney(ZERO);
const count: number = "not a number";
const cents = ZERO.amount;

export function describe(): string {
  return \`\${label} \${origin.x} \${step.length()} \${count} \${cents}\`;
}
`;

export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["src"]
}
`,
  "src/main.ts": MAIN_TEXT,
  "src/shapes.ts": `export interface Point {
  readonly x: number;
  readonly y: number;
}

export class Vector {
  constructor(
    public x: number,
    public y: number,
  ) {}

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  add(other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y);
  }
}

export function makePoint(x: number, y: number): Point {
  return { x, y };
}
`,
  "node_modules/tiny-money/package.json": `{
  "name": "tiny-money",
  "version": "1.0.0",
  "types": "index.d.ts",
  "main": "index.js"
}
`,
  "node_modules/tiny-money/index.d.ts": `export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export declare function formatMoney(value: Money): string;

export declare function addMoney(left: Money, right: Money): Money;

export declare const ZERO: Money;
`,
};
