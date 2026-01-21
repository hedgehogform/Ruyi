import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { evaluate } from "mathjs";

export const calculatorDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "calculator",
    description:
      "Perform mathematical calculations. Supports basic arithmetic (+, -, *, /, %), exponents (^), square roots, trigonometry, logarithms, matrices, units, and more. Use this for any math the user asks about.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description:
            "A mathjs expression to evaluate. Supports: arithmetic (2+2, 10/3), exponents (2^8), functions (sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil), trigonometry with units (sin(45 deg)), unit conversions (5 inches to cm, 100 km/h to mph), matrices (det([[1,2],[3,4]]), inv(matrix)), complex numbers (sqrt(-1), 2+3i), constants (pi, e, phi), and more. See mathjs documentation for full syntax.",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
};

export function calculate(expression: string): string {
  toolLogger.info({ expression }, "Calculating expression");

  try {
    const result = evaluate(expression);
    const formatted = String(result);

    toolLogger.info({ expression, result: formatted }, "Calculation complete");

    return JSON.stringify({
      expression,
      result: formatted,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ expression, error: errorMessage }, "Calculation failed");

    return JSON.stringify({
      expression,
      error: errorMessage,
    });
  }
}
