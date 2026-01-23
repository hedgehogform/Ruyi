import { tool } from "@openrouter/sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { evaluate } from "mathjs";

export const calculatorTool = tool({
  name: "calculator",
  description:
    "Perform mathematical calculations. Supports basic arithmetic (+, -, *, /, %), exponents (^), square roots, trigonometry, logarithms, matrices, units, and more. Use this for any math the user asks about.",
  inputSchema: z.object({
    expression: z
      .string()
      .describe(
        "A mathjs expression to evaluate. Supports: arithmetic (2+2, 10/3), exponents (2^8), functions (sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil), trigonometry with units (sin(45 deg)), unit conversions (5 inches to cm, 100 km/h to mph), matrices (det([[1,2],[3,4]]), inv(matrix)), complex numbers (sqrt(-1), 2+3i), constants (pi, e, phi), and more."
      ),
  }),
  execute: async ({ expression }) => {
    toolLogger.info({ expression }, "Calculating expression");
    try {
      const result = String(evaluate(expression));
      toolLogger.info({ expression, result }, "Calculation complete");
      return { expression, result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ expression, error: errorMessage }, "Calculation failed");
      return { expression, error: errorMessage };
    }
  },
});
