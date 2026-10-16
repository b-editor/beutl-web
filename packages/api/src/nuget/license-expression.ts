import exceptions from "spdx-exceptions/index.json";
import deprecatedExceptions from "spdx-exceptions/deprecated.json";
import deprecatedLicenses from "spdx-license-ids/deprecated.json";

const exceptionIds = new Set(exceptions);
const reservedIds = new Set([...exceptions, ...deprecatedExceptions, ...deprecatedLicenses]);
const precedence: Record<string, number> = { OR: 1, AND: 2, WITH: 3 };

function license(value: string, allowUnlicensed = false): boolean {
  if (value === "UNLICENSED") return allowUnlicensed;
  const id = value.replace(/\+$/u, "");
  // NuGet allows nonstandard license IDs, but not deprecated IDs, exception
  // IDs used as licenses, or UNLICENSED inside a compound expression.
  return /^[a-zA-Z0-9.-]+\+?$/u.test(value) && id !== "UNLICENSED" && !reservedIds.has(id);
}

export function isValidNugetLicenseExpression(value: string): boolean {
  if (value.length > 2048) return false;
  const expression = value.trim();
  if (!/^[a-zA-Z0-9.()+ -]+$/u.test(expression)) return false;
  // NuGet separates tokens with spaces and permits parentheses at their edges.
  // Keep embedded parentheses and non-space separators invalid.
  const tokens = expression.split(/ +/u).flatMap((part) => {
    const [, before, identifier, after] = /^([()]*)(.*?)([()]*)$/u.exec(part)!;
    return [...before, ...(identifier ? [identifier] : []), ...after];
  });
  const operators: string[] = [];
  const operands: (string | true)[] = [];
  const validOperand = (operand: string | true) => operand === true || license(operand);
  const reduce = () => {
    const operator = operators.pop(), right = operands.pop(), left = operands.pop();
    if (right === undefined || left === undefined) return false;
    const valid = operator === "WITH"
      ? typeof left === "string" && typeof right === "string" && license(left) && exceptionIds.has(right)
      : validOperand(left) && validOperand(right);
    if (valid) operands.push(true);
    return valid;
  };
  let expectOperand = true;
  for (const token of tokens) {
    if (token === "(") {
      if (!expectOperand) return false;
      operators.push(token);
    } else if (token === ")") {
      if (expectOperand) return false;
      while (operators.length && operators.at(-1) !== "(") if (!reduce()) return false;
      if (operators.pop() !== "(") return false;
    } else if (Object.hasOwn(precedence, token)) {
      if (expectOperand) return false;
      while (operators.length && precedence[operators.at(-1)!] >= precedence[token]) if (!reduce()) return false;
      operators.push(token);
      expectOperand = true;
    } else {
      if (!expectOperand || !/^[a-zA-Z0-9.-]+\+?$/u.test(token)) return false;
      operands.push(token);
      expectOperand = false;
    }
  }
  if (expectOperand) return false;
  while (operators.length) if (operators.at(-1) === "(" || !reduce()) return false;
  return operands.length === 1 && (operands[0] === true || license(operands[0], true));
}
